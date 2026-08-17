/**
 * Hybrid-retrieval benchmark (READ-ONLY against real tables).
 *
 * Candidate-retrieval methods compared:
 *   - dense   : embedding cosine kNN (HNSW)          — what Stage 3a / Tier-2 do today
 *   - fts     : Postgres FTS ts_rank_cd (Snowball-stemmed cover-density ranking)
 *   - tfidf   : classic TF-IDF cosine over folded raw tokens (computed in JS)
 *   - hybrid  : Reciprocal-Rank Fusion of dense + tfidf
 *
 * The only persisted artifact is the ISOLATED table `bench_known_entity_forms`
 * (name embeddings cache for the `ke` mode; nothing else references it; drop with
 * `DROP TABLE bench_known_entity_forms`). It is reseed-safe — it delta-syncs to the
 * current known_entities and reuses embeddings by text, so a KB reseed re-syncs
 * without re-spending the API. Everything else is SELECT-only / session TEMP tables.
 *
 * Usage:
 *   npx tsx data/hybrid-retrieval-benchmark/bench.ts stats
 *   npx tsx data/hybrid-retrieval-benchmark/bench.ts entity --sample 500
 *   npx tsx data/hybrid-retrieval-benchmark/bench.ts ke     --sample 5000
 *   npx tsx data/hybrid-retrieval-benchmark/bench.ts events --sample 500
 */
import pg from 'pg';
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Tunables ────────────────────────────────────────────────────────────────
const K_RETRIEVE = 50;            // candidates each retriever returns, pre-fusion
const KS = [1, 5, 10, 20];        // evaluation cut-offs
const RRF_K0 = 60;                // Reciprocal-Rank-Fusion constant (standard default)
const HNSW_EF_SEARCH = 100;       // raise recall of the approximate kNN toward exact

// ── Connection (mirrors packages/db/src/pool.ts) ─────────────────────────────
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

// ── Diacritic fold (matches services/.../db/entity/tokens.ts foldAscii) ──────
const EXT_LATIN: Record<string, string> = {
  'Ł': 'L', 'ł': 'l', 'Đ': 'Dj', 'đ': 'dj', 'Ø': 'O', 'ø': 'o',
  'Æ': 'Ae', 'æ': 'ae', 'ß': 'ss', 'Þ': 'Th', 'þ': 'th', 'Ð': 'D', 'ð': 'd',
};
function foldAscii(s: string): string {
  let out = '';
  for (const ch of s) out += EXT_LATIN[ch] ?? ch;
  return out.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
const norm = (s: string | null) => foldAscii((s ?? '').toLowerCase()).trim();

// ── Ranked-list types + fusion ───────────────────────────────────────────────
interface Cand { key: string; canonical: string }
type Ranked = Cand[];

/** Reciprocal-Rank Fusion of N ranked candidate lists, keyed by `key`. */
function rrf(...lists: Ranked[]): Ranked {
  const acc = new Map<string, { canonical: string; score: number }>();
  for (const list of lists) {
    list.forEach((c, i) => {
      const e = acc.get(c.key) ?? { canonical: c.canonical, score: 0 };
      e.score += 1 / (RRF_K0 + i + 1);
      acc.set(c.key, e);
    });
  }
  return [...acc.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .map(([key, v]) => ({ key, canonical: v.canonical }));
}

// ── Per-query / aggregate metrics ────────────────────────────────────────────
interface MethodAgg {
  recallAtK: Record<number, number>; // hits / n
  mrrSum: number;
  fpAtK: Record<number, number>;      // sum of wrong-candidate counts in top-k
}
function newAgg(): MethodAgg {
  return {
    recallAtK: Object.fromEntries(KS.map(k => [k, 0])),
    mrrSum: 0,
    fpAtK: Object.fromEntries(KS.map(k => [k, 0])),
  };
}

/** First 1-based rank where a candidate matches the truth, else Infinity. */
function firstHitRank(list: Ranked, truth: string): number {
  for (let i = 0; i < list.length; i++) {
    if (norm(list[i].canonical) === truth) return i + 1;
  }
  return Infinity;
}

function scoreInto(agg: MethodAgg, list: Ranked, truth: string): number {
  const rank = firstHitRank(list, truth);
  if (rank !== Infinity) {
    agg.mrrSum += 1 / rank;
    for (const k of KS) if (rank <= k) agg.recallAtK[k] += 1;
  }
  for (const k of KS) {
    const topk = list.slice(0, k);
    agg.fpAtK[k] += topk.filter(c => norm(c.canonical) !== truth).length;
  }
  return rank;
}

// ── Reporting ─────────────────────────────────────────────────────────────────
function fmtPct(x: number): string { return (100 * x).toFixed(1) + '%'; }

function buildReport(
  mode: string,
  n: number,
  meta: Record<string, unknown>,
  aggs: Record<string, MethodAgg>,
  ranks: Record<string, number>[],
  hybridName = 'hybrid',
): { md: string; json: unknown } {
  const methods = Object.keys(aggs);
  const recallRow = (m: string) => KS.map(k => fmtPct(aggs[m].recallAtK[k] / n));
  const mrr = (m: string) => (aggs[m].mrrSum / n).toFixed(3);
  const fp = (m: string, k: number) => (aggs[m].fpAtK[k] / n).toFixed(2);
  const rk = (r: Record<string, number>, m: string) => r[m] ?? Infinity;

  // Blind-spot matrix: for each reference method, of the queries it misses @20,
  // how often does each OTHER method land the truth @20?
  const miss = (m: string) => ranks.filter(r => rk(r, m) > 20);
  const rescue = (subset: Record<string, number>[], m: string) =>
    subset.length === 0 ? NaN : subset.filter(r => rk(r, m) <= 20).length / subset.length;

  const ts = new Date().toISOString();
  const L: string[] = [];
  L.push(`# Benchmark run — ${mode}`, '');
  L.push(`- timestamp: \`${ts}\``, `- queries evaluated: **${n}**`);
  for (const [k, v] of Object.entries(meta)) L.push(`- ${k}: ${v}`);
  L.push('', '## Recall / MRR', '');
  L.push(`| method | R@1 | R@5 | R@10 | R@20 | MRR |`, `|---|---|---|---|---|---|`);
  for (const m of methods) L.push(`| ${m} | ${recallRow(m).join(' | ')} | ${mrr(m)} |`);
  L.push('', '## Candidate noise (mean wrong candidates in top-k = LLM-verify cost)', '');
  L.push(`| method | FP@1 | FP@5 | FP@10 | FP@20 |`, `|---|---|---|---|---|`);
  for (const m of methods) L.push(`| ${m} | ${KS.map(k => fp(m, k)).join(' | ')} |`);

  L.push('', '## Blind-spot rescue (of queries a method misses @20, who rescues)', '');
  L.push(`| misses @20 → | count | ${methods.map(m => `rescued by ${m}`).join(' | ')} |`);
  L.push(`|---|---|${methods.map(() => '---').join('|')}|`);
  const blindSpot: Record<string, unknown> = {};
  for (const ref of methods) {
    const sub = miss(ref);
    blindSpot[ref] = { miss20: sub.length, rescue: Object.fromEntries(methods.map(m => [m, rescue(sub, m)])) };
    L.push(`| **${ref}** | ${sub.length} (${fmtPct(sub.length / n)}) | ` +
      methods.map(m => (m === ref ? '—' : fmtPct(rescue(sub, m)))).join(' | ') + ' |');
  }

  // Pairwise @20 deltas vs the hybrid/fused method.
  L.push('', `## ${hybridName} vs each base method @20`, '');
  const deltas: Record<string, unknown> = {};
  if (methods.includes(hybridName)) {
    for (const base of methods.filter(m => m !== hybridName)) {
      const gain = ranks.filter(r => rk(r, hybridName) <= 20 && rk(r, base) > 20).length;
      const loss = ranks.filter(r => rk(r, hybridName) > 20 && rk(r, base) <= 20).length;
      deltas[base] = { gain, loss };
      L.push(`- vs **${base}**: net-new **${gain}**, net-loss **${loss}**`);
    }
  }
  L.push('');

  const json = {
    mode, timestamp: ts, n, meta,
    methods: Object.fromEntries(methods.map(m => [m, {
      recallAtK: Object.fromEntries(KS.map(k => [k, aggs[m].recallAtK[k] / n])),
      mrr: aggs[m].mrrSum / n,
      fpAtK: Object.fromEntries(KS.map(k => [k, aggs[m].fpAtK[k] / n])),
    }])),
    blindSpot, deltas,
  };
  return { md: L.join('\n'), json };
}

// ── TF-IDF cosine retriever (in-JS) — pluggable tokenizer ──
// Word tokens: folded, raw (no stemming), length >= 2.
function tfidfTokens(text: string): string[] {
  return foldAscii(text.toLowerCase()).split(/[^a-z0-9]+/).filter(t => t.length >= 2);
}
// Character 3-grams over the folded string (spaces collapsed to '_'). Catches
// typos, morphology (democratic/democrats), and substring overlap (coinbase/coin)
// that word-level tokens miss. Padded so short tokens still produce n-grams.
function charNgrams(text: string, n = 3): string[] {
  const s = '_' + foldAscii(text.toLowerCase()).replace(/[^a-z0-9]+/g, '_') + '_';
  if (s.length < n) return [s];
  const out: string[] = [];
  for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n));
  return out;
}

interface TfIdfDoc { entityId: number; form: string; domain: string }

class TfIdf {
  private docs: TfIdfDoc[] = [];
  private idf = new Map<string, number>();
  private postings = new Map<string, { doc: number; w: number }[]>();
  private normVec: number[] = [];
  constructor(private readonly tok: (s: string) => string[] = tfidfTokens) {}

  build(rows: TfIdfDoc[]): void {
    this.docs = rows;
    const tokenized = rows.map(r => this.tok(r.form));
    const df = new Map<string, number>();
    for (const toks of tokenized) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
    const N = rows.length;
    for (const [t, d] of df) this.idf.set(t, Math.log(1 + N / d));
    this.normVec = new Array(N).fill(0);
    for (let d = 0; d < N; d++) {
      const tf = new Map<string, number>();
      for (const t of tokenized[d]) tf.set(t, (tf.get(t) ?? 0) + 1);
      let sq = 0;
      for (const [t, c] of tf) {
        const w = c * (this.idf.get(t) ?? 0);
        sq += w * w;
        if (!this.postings.has(t)) this.postings.set(t, []);
        this.postings.get(t)!.push({ doc: d, w });
      }
      this.normVec[d] = Math.sqrt(sq) || 1;
    }
  }

  /** Top-k by cosine, domain-scoped (same / 'other'), excluding `excludeKey`. */
  query(text: string, qdomain: string, k: number, excludeKey: string): { entityId: number; form: string; score: number }[] {
    const tf = new Map<string, number>();
    for (const t of this.tok(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let qsq = 0;
    const qw = new Map<string, number>();
    for (const [t, c] of tf) { const w = c * (this.idf.get(t) ?? 0); qw.set(t, w); qsq += w * w; }
    const qnorm = Math.sqrt(qsq) || 1;
    const dot = new Map<number, number>();
    for (const [t, w] of qw) {
      const post = this.postings.get(t);
      if (!post) continue;
      for (const p of post) dot.set(p.doc, (dot.get(p.doc) ?? 0) + w * p.w);
    }
    const out: { entityId: number; form: string; score: number }[] = [];
    for (const [d, dp] of dot) {
      const doc = this.docs[d];
      if (`${doc.entityId}:${doc.form}` === excludeKey) continue;
      if (!(doc.domain === qdomain || doc.domain === 'other' || qdomain === 'other')) continue;
      out.push({ entityId: doc.entityId, form: doc.form, score: dp / (qnorm * this.normVec[d]) });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, k);
  }
}

// ── Discrepancy dump (qualitative "which detections are better") ─────────────
interface DiscRow { query: string; domain: string; entityId: number; truthForms: string[];
  perMethod: Record<string, { form: string; entityId: number; tag: string }[]> }

function writeDiscrepancies(buckets: Record<string, DiscRow[]>): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(HERE, `discrepancies-ke-${stamp}.md`);
  const L: string[] = [`# Discrepancy examples — ke (${stamp})`, ''];
  L.push('`*` marks a candidate that is a TRUE sibling (same entity_id as the query).', '');
  for (const [cat, rows] of Object.entries(buckets)) {
    L.push(`## ${cat}  (${rows.length} shown)`, '');
    for (const r of rows) {
      L.push(`### query: \`${r.query}\`  (entity ${r.entityId}, ${r.domain})`);
      L.push(`- true siblings: ${r.truthForms.map(f => `\`${f}\``).join(', ') || '(none in index)'}`);
      for (const [m, cands] of Object.entries(r.perMethod)) {
        const shown = cands.slice(0, 5).map(c =>
          `${c.entityId === r.entityId ? '*' : ''}\`${c.form}\`${c.tag}`).join(', ');
        L.push(`- ${m}: ${shown || '(none)'}`);
      }
      L.push('');
    }
  }
  writeFileSync(path, L.join('\n'));
  console.log(`wrote ${path}`);
}

function writeResults(mode: string, report: { md: string; json: unknown }): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = join(HERE, `results-${mode}-${stamp}`);
  writeFileSync(base + '.md', report.md);
  writeFileSync(base + '.json', JSON.stringify(report.json, null, 2));
  console.log(`\nwrote ${base}.md and .json`);
}

// ── Arg parsing ───────────────────────────────────────────────────────────────
function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1], 10) : dflt;
}

// ═══════════════════════════════════════════════════════════════════════════
//  stats
// ═══════════════════════════════════════════════════════════════════════════
async function runStats(pool: pg.Pool): Promise<void> {
  const one = async (label: string, sql: string) => {
    const r = await pool.query(sql);
    console.log(`  ${label.padEnd(46)} ${JSON.stringify(r.rows[0] ?? r.rows)}`);
  };
  console.log('entity_subjects:');
  await one('total rows', `SELECT count(*) AS n FROM entity_subjects`);
  await one('distinct canonicals', `SELECT count(DISTINCT canonical_subject) AS n FROM entity_subjects`);
  await one('eligible queries (canonical w/ >=2 variants)',
    `SELECT count(*) AS n FROM (
       SELECT canonical_subject, domain_category
       FROM entity_subjects GROUP BY 1,2
       HAVING count(DISTINCT subject_text) >= 2) t`);
  await one('rows under those eligible canonicals',
    `SELECT count(*) AS n FROM entity_subjects e
       JOIN (SELECT canonical_subject, domain_category FROM entity_subjects
             GROUP BY 1,2 HAVING count(DISTINCT subject_text) >= 2) m
       ON e.canonical_subject=m.canonical_subject AND e.domain_category=m.domain_category`);
  console.log('  by domain:');
  const dom = await pool.query(
    `SELECT domain_category, count(*) AS n FROM entity_subjects GROUP BY 1 ORDER BY 2 DESC`);
  for (const r of dom.rows) console.log(`    ${String(r.domain_category).padEnd(16)} ${r.n}`);

  console.log('\nknown_entities (richer entity substrate — needs embeddings):');
  await one('total rows', `SELECT count(*) AS n FROM known_entities`);
  await one('with >=1 alias',
    `SELECT count(*) AS n FROM known_entities WHERE jsonb_array_length(aliases) >= 1`);
  await one('with >=2 aliases (eligible LOO queries)',
    `SELECT count(*) AS n FROM known_entities WHERE jsonb_array_length(aliases) >= 2`);
  await one('total surface forms to embed (canonical + aliases)',
    `SELECT count(*) AS n FROM (
       SELECT canonical FROM known_entities
       UNION ALL
       SELECT jsonb_array_elements_text(aliases) FROM known_entities) t`);

  console.log('\nmarkets (featurization = has a market_features row):');
  await one('total markets', `SELECT count(*) AS n FROM markets`);
  await one('featurized (market_features rows)', `SELECT count(*) AS n FROM market_features`);
  await one('markets WITHOUT features',
    `SELECT count(*) AS n FROM markets m
       WHERE NOT EXISTS (SELECT 1 FROM market_features f WHERE f.market_id = m.id)`);
  await one('markets WITH embedding', `SELECT count(*) AS n FROM markets WHERE embedding IS NOT NULL`);
  console.log('  unfeaturized by platform:');
  const unf = await pool.query(
    `SELECT m.platform, count(*) AS n FROM markets m
       WHERE NOT EXISTS (SELECT 1 FROM market_features f WHERE f.market_id = m.id)
       GROUP BY 1 ORDER BY 2 DESC`);
  for (const r of unf.rows) console.log(`    ${String(r.platform).padEnd(16)} ${r.n}`);

  console.log('\nplatform_events (event phase 2):');
  await one('total', `SELECT count(*) AS n FROM platform_events`);
  await one('embedded', `SELECT count(*) AS n FROM platform_events WHERE embedding IS NOT NULL`);
  await one('confirmed cross-platform sibling pairs (embedded)',
    `SELECT count(*) AS n FROM semantic_event_platforms a
       JOIN semantic_event_platforms b
         ON a.semantic_event_id=b.semantic_event_id AND a.platform_event_id<b.platform_event_id
       JOIN platform_events pa ON pa.id=a.platform_event_id AND pa.embedding IS NOT NULL
       JOIN platform_events pb ON pb.id=b.platform_event_id AND pb.embedding IS NOT NULL
       WHERE pa.platform <> pb.platform`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  entity-resolution benchmark  (entity_subjects)
// ═══════════════════════════════════════════════════════════════════════════
async function runEntity(pool: pg.Pool, sample: number): Promise<void> {
  // 1. Build the lexical index in a session TEMP table (auto-drops; no real-table writes).
  const lexClient = await pool.connect();
  await lexClient.query(`
    CREATE TEMP TABLE bench_subj ON COMMIT PRESERVE ROWS AS
      SELECT subject_text, canonical_subject, domain_category,
             to_tsvector('english', subject_text) AS tsv
        FROM entity_subjects`);
  await lexClient.query(`CREATE INDEX ON bench_subj USING gin(tsv)`);
  await lexClient.query(`ANALYZE bench_subj`);

  // 2. Dedicated dense client with session GUCs so HNSW is used at high recall.
  const denseClient = await pool.connect();
  await denseClient.query(`SET enable_seqscan = off`);
  await denseClient.query(`SET hnsw.ef_search = ${HNSW_EF_SEARCH}`);

  // 3. Deterministic query sample over eligible rows (canonical has >=2 variants).
  const qset = await pool.query<{ subject_text: string; canonical_subject: string; domain_category: string; emb: string }>(
    `SELECT e.subject_text, e.canonical_subject, e.domain_category, e.embedding::text AS emb
       FROM entity_subjects e
       JOIN (SELECT canonical_subject, domain_category FROM entity_subjects
             GROUP BY 1,2 HAVING count(DISTINCT subject_text) >= 2) m
         ON e.canonical_subject=m.canonical_subject AND e.domain_category=m.domain_category
      ORDER BY md5(e.subject_text || '|' || e.domain_category)
      LIMIT $1`,
    [sample],
  );
  const queries = qset.rows;
  console.log(`entity: ${queries.length} eligible queries sampled (target ${sample})`);
  if (queries.length === 0) {
    console.log('No eligible queries — entity_subjects has no canonical with >=2 surface forms yet.');
    lexClient.release(); denseClient.release();
    return;
  }

  const aggs = { dense: newAgg(), lexical: newAgg(), hybrid: newAgg() };
  const ranks: { dense: number; lexical: number; hybrid: number }[] = [];

  let i = 0;
  for (const q of queries) {
    const truth = norm(q.canonical_subject);

    // dense kNN (HNSW), domain-scoped, excluding the query row itself.
    const dRes = await denseClient.query<{ subject_text: string; canonical_subject: string }>(
      `SELECT subject_text, canonical_subject
         FROM entity_subjects
        WHERE subject_text <> $2
          AND (domain_category = $3 OR domain_category = 'other' OR $3 = 'other')
        ORDER BY embedding <=> $1::vector
        LIMIT $4`,
      [q.emb, q.subject_text, q.domain_category, K_RETRIEVE],
    );
    const dense: Ranked = dRes.rows.map(r => ({ key: r.subject_text, canonical: r.canonical_subject }));

    // lexical ts_rank_cd over the TEMP FTS index.
    const lRes = await lexClient.query<{ subject_text: string; canonical_subject: string }>(
      `SELECT subject_text, canonical_subject
         FROM bench_subj
        WHERE subject_text <> $1
          AND (domain_category = $2 OR domain_category = 'other' OR $2 = 'other')
          AND tsv @@ plainto_tsquery('english', $1)
        ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', $1)) DESC, subject_text
        LIMIT $3`,
      [q.subject_text, q.domain_category, K_RETRIEVE],
    );
    const lexical: Ranked = lRes.rows.map(r => ({ key: r.subject_text, canonical: r.canonical_subject }));

    const hybrid = rrf(dense, lexical);

    ranks.push({
      dense: scoreInto(aggs.dense, dense, truth),
      lexical: scoreInto(aggs.lexical, lexical, truth),
      hybrid: scoreInto(aggs.hybrid, hybrid, truth),
    });

    if (++i % 100 === 0) console.log(`  …${i}/${queries.length}`);
  }

  lexClient.release();
  denseClient.release();

  const report = buildReport('entity', queries.length,
    { substrate: 'entity_subjects', K_RETRIEVE, RRF_K0, HNSW_EF_SEARCH }, aggs, ranks);
  console.log('\n' + report.md);
  writeResults('entity', report);
}

// ═══════════════════════════════════════════════════════════════════════════
//  known_entities benchmark  (ke)  — representative entity-dedup substrate
//  Persists name embeddings in an ISOLATED table `bench_known_entity_forms`
//  (new table; nothing in the pipeline references it; drop when done with
//  `DROP TABLE bench_known_entity_forms`). Tests the merge-probe blind spot.
// ═══════════════════════════════════════════════════════════════════════════
const OPENAI_EMBED_MODEL = 'text-embedding-3-small';
const OPENAI_EMBED_DIM = 1536;
const EMBED_BATCH = 100;

async function embedBatch(apiKey: string, inputs: string[]): Promise<number[][]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: OPENAI_EMBED_MODEL, input: inputs, dimensions: OPENAI_EMBED_DIM }),
    });
    if (res.ok) {
      const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    throw new Error(`OpenAI embed ${res.status}: ${await res.text()}`);
  }
}

/**
 * Create + delta-sync the isolated embedding table to the CURRENT known_entities.
 * Reseed-safe: rows whose (entity_id, form) no longer exist are deleted; new rows
 * are inserted reusing any embedding already stored for the same text, so a KB
 * reseed that only re-numbers entity_ids costs $0 in re-embedding.
 */
async function ensureKeTable(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bench_known_entity_forms (
      entity_id       integer NOT NULL,
      form            text    NOT NULL,
      is_canon        boolean NOT NULL,
      domain_category text    NOT NULL,
      embedding       vector(${OPENAI_EMBED_DIM}),
      tsv             tsvector,
      PRIMARY KEY (entity_id, form)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bench_ke_hnsw ON bench_known_entity_forms USING hnsw (embedding vector_cosine_ops)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS bench_ke_gin  ON bench_known_entity_forms USING gin (tsv)`);

  const want = await pool.query<{ entity_id: number; form: string; is_canon: boolean; domain_category: string }>(
    `SELECT entity_id, form, bool_or(is_canon) AS is_canon, min(domain_category) AS domain_category
       FROM (
         SELECT id AS entity_id, lower(btrim(canonical)) AS form, true  AS is_canon, domain_category FROM known_entities
         UNION ALL
         SELECT id, lower(btrim(jsonb_array_elements_text(aliases))), false, domain_category FROM known_entities
       ) s
      WHERE length(form) > 0
      GROUP BY entity_id, form`);

  // Existing rows keyed by entity_id -> form (nested Set, no string separator) + a
  // text -> embedding cache so unchanged names are never re-embedded after a reseed.
  const have = await pool.query<{ entity_id: number; form: string; emb: string | null }>(
    `SELECT entity_id, form, embedding::text AS emb FROM bench_known_entity_forms`);
  const haveByEid = new Map<number, Set<string>>();
  const wantByEid = new Map<number, Set<string>>();
  const textVec = new Map<string, string>();
  for (const r of have.rows) {
    if (!haveByEid.has(r.entity_id)) haveByEid.set(r.entity_id, new Set());
    haveByEid.get(r.entity_id)!.add(r.form);
    if (r.emb && !textVec.has(r.form)) textVec.set(r.form, r.emb);
  }
  for (const r of want.rows) {
    if (!wantByEid.has(r.entity_id)) wantByEid.set(r.entity_id, new Set());
    wantByEid.get(r.entity_id)!.add(r.form);
  }
  const toDelete = have.rows.filter(r => !wantByEid.get(r.entity_id)?.has(r.form));
  const toInsert = want.rows.filter(r => !haveByEid.get(r.entity_id)?.has(r.form));
  const needEmbed = [...new Set(toInsert.map(r => r.form).filter(f => !textVec.has(f)))];

  console.log(`ke sync: want=${want.rows.length} have=${have.rows.length} -> delete=${toDelete.length} insert=${toInsert.length} embed=${needEmbed.length}`);

  if (needEmbed.length > 0) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set (needed to embed known_entities names)');
    for (let i = 0; i < needEmbed.length; i += EMBED_BATCH) {
      const chunk = needEmbed.slice(i, i + EMBED_BATCH);
      const vecs = await embedBatch(apiKey, chunk);
      chunk.forEach((t, j) => textVec.set(t, `[${vecs[j].join(',')}]`));
      if ((i / EMBED_BATCH) % 10 === 0) console.log(`  embedded ${Math.min(i + EMBED_BATCH, needEmbed.length)}/${needEmbed.length} new names`);
    }
  }

  for (let i = 0; i < toDelete.length; i += 1000) {
    const b = toDelete.slice(i, i + 1000);
    await pool.query(
      `DELETE FROM bench_known_entity_forms t
        USING unnest($1::int[], $2::text[]) d(eid, form)
        WHERE t.entity_id = d.eid AND t.form = d.form`,
      [b.map(x => x.entity_id), b.map(x => x.form)]);
  }
  for (let i = 0; i < toInsert.length; i += 500) {
    const b = toInsert.slice(i, i + 500);
    await pool.query(
      `INSERT INTO bench_known_entity_forms (entity_id, form, is_canon, domain_category, embedding, tsv)
       SELECT u.eid, u.form, u.canon, u.dom, u.vec::vector, to_tsvector('english', u.form)
         FROM unnest($1::int[], $2::text[], $3::bool[], $4::text[], $5::text[])
              AS u(eid, form, canon, dom, vec)
       ON CONFLICT (entity_id, form) DO NOTHING`,
      [b.map(x => x.entity_id), b.map(x => x.form), b.map(x => x.is_canon),
       b.map(x => x.domain_category), b.map(x => textVec.get(x.form)!)]);
  }
  if (toDelete.length || toInsert.length) await pool.query(`ANALYZE bench_known_entity_forms`);
  console.log(`ke sync: done`);
}

const BUCKET_CAP = 15;
async function runKe(pool: pg.Pool, sample: number): Promise<void> {
  await ensureKeTable(pool);

  const denseClient = await pool.connect();
  await denseClient.query(`SET enable_seqscan = off`);
  await denseClient.query(`SET hnsw.ef_search = ${HNSW_EF_SEARCH}`);

  // Build word- and char-ngram TF-IDF indexes + entity→forms + form→entities maps.
  const corpus = await pool.query<{ entity_id: number; form: string; domain_category: string }>(
    `SELECT entity_id, form, domain_category FROM bench_known_entity_forms WHERE embedding IS NOT NULL`);
  const docs = corpus.rows.map(r => ({ entityId: r.entity_id, form: r.form, domain: r.domain_category }));
  const tfidf = new TfIdf(tfidfTokens);
  tfidf.build(docs);
  const tfidfChar = new TfIdf(s => charNgrams(s, 3));
  tfidfChar.build(docs);
  const entityForms = new Map<number, string[]>();
  const formEntities = new Map<string, Set<number>>();
  for (const r of corpus.rows) {
    if (!entityForms.has(r.entity_id)) entityForms.set(r.entity_id, []);
    entityForms.get(r.entity_id)!.push(r.form);
    if (!formEntities.has(r.form)) formEntities.set(r.form, new Set());
    formEntities.get(r.form)!.add(r.entity_id);
  }
  // Label-noise signal: the held-out form text also exists under another entity_id
  // → either a KB dedup gap (false-negative label) or a genuinely ambiguous alias.
  const exactTwin = (form: string) => (formEntities.get(form)?.size ?? 0) > 1;
  console.log(`ke: indexes built over ${docs.length} forms (word + char-3gram TF-IDF)`);

  // One leave-one-out query per eligible entity (>=2 distinct forms so a sibling
  // survives). Hold out a deterministically chosen form (the "incoming stub");
  // index keeps canonical + the rest (the "established row").
  const qset = await pool.query<{ entity_id: number; form: string; domain_category: string; emb: string }>(
    `WITH f AS (
       SELECT entity_id, form, domain_category, embedding,
              row_number() OVER (PARTITION BY entity_id ORDER BY md5(form)) AS rn,
              count(*)     OVER (PARTITION BY entity_id) AS cnt
         FROM bench_known_entity_forms
        WHERE embedding IS NOT NULL)
     SELECT entity_id, form, domain_category, embedding::text AS emb
       FROM f WHERE cnt >= 2 AND rn = 1
      ORDER BY md5(entity_id::text) LIMIT $1`,
    [sample]);
  console.log(`ke: ${qset.rows.length} leave-one-out queries (entities with >=2 forms)`);
  if (qset.rows.length === 0) { denseClient.release(); return; }

  const aggs = {
    dense: newAgg(), fts: newAgg(), tfidf: newAgg(), tfidf_char: newAgg(),
    hybrid: newAgg(), hybrid3: newAgg(),
  };
  const ranks: Record<string, number>[] = [];
  const buckets: Record<string, DiscRow[]> = {
    'dense-only (all lexical methods miss)': [],
    'lexical-only (dense misses; word/char tfidf hits)': [],
    'char-3gram rescue (word-tfidf misses; char-tfidf hits)': [],
    'label-noise: held-out form shared by ≥2 entities (KB dup/ambiguous)': [],
  };
  let twinQ = 0, denseTop1Twin = 0, missWithTwin = 0;

  let i = 0;
  for (const q of qset.rows) {
    const truth = norm(String(q.entity_id));
    const key = `${q.entity_id}:${q.form}`;
    const twin = exactTwin(q.form);

    const dRes = await denseClient.query<{ entity_id: number; form: string; dist: number }>(
      `SELECT entity_id, form, (embedding <=> $1::vector) AS dist FROM bench_known_entity_forms
        WHERE NOT (entity_id = $2 AND form = $3)
          AND (domain_category = $4 OR domain_category = 'other' OR $4 = 'other')
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector LIMIT $5`,
      [q.emb, q.entity_id, q.form, q.domain_category, K_RETRIEVE]);
    const dense: Ranked = dRes.rows.map(r => ({ key: `${r.entity_id}:${r.form}`, canonical: String(r.entity_id) }));

    const lRes = await pool.query<{ entity_id: number; form: string }>(
      `SELECT entity_id, form FROM bench_known_entity_forms
        WHERE NOT (entity_id = $2 AND form = $3)
          AND (domain_category = $4 OR domain_category = 'other' OR $4 = 'other')
          AND tsv @@ plainto_tsquery('english', $1)
        ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', $1)) DESC, entity_id LIMIT $5`,
      [q.form, q.entity_id, q.form, q.domain_category, K_RETRIEVE]);
    const fts: Ranked = lRes.rows.map(r => ({ key: `${r.entity_id}:${r.form}`, canonical: String(r.entity_id) }));

    const tfRows = tfidf.query(q.form, q.domain_category, K_RETRIEVE, key);
    const tf: Ranked = tfRows.map(r => ({ key: `${r.entityId}:${r.form}`, canonical: String(r.entityId) }));
    const tfcRows = tfidfChar.query(q.form, q.domain_category, K_RETRIEVE, key);
    const tfc: Ranked = tfcRows.map(r => ({ key: `${r.entityId}:${r.form}`, canonical: String(r.entityId) }));

    const hybrid = rrf(dense, tf);            // dense + word-tfidf
    const hybrid3 = rrf(dense, tf, tfc);      // dense + word-tfidf + char-tfidf

    const rD = scoreInto(aggs.dense, dense, truth);
    const rF = scoreInto(aggs.fts, fts, truth);
    const rT = scoreInto(aggs.tfidf, tf, truth);
    const rC = scoreInto(aggs.tfidf_char, tfc, truth);
    const rH = scoreInto(aggs.hybrid, hybrid, truth);
    const rH3 = scoreInto(aggs.hybrid3, hybrid3, truth);
    ranks.push({ dense: rD, fts: rF, tfidf: rT, tfidf_char: rC, hybrid: rH, hybrid3: rH3 });

    // ── Label-verification audit ──
    if (twin) twinQ++;
    const top1 = dRes.rows[0];
    if (top1 && top1.form === q.form && top1.entity_id !== q.entity_id) denseTop1Twin++;
    if (rH3 > 20 && twin) missWithTwin++;

    // ── Discrepancy capture ──
    const denseHit = rD <= 20, ftsHit = rF <= 20, tfHit = rT <= 20, tfcHit = rC <= 20;
    const truthForms = (entityForms.get(q.entity_id) ?? []).filter(f => f !== q.form);
    const mk = (): DiscRow => ({
      query: q.form, domain: q.domain_category, entityId: q.entity_id, truthForms,
      perMethod: {
        dense: dRes.rows.slice(0, 5).map(r => ({ form: r.form, entityId: r.entity_id, tag: ` (cos ${(1 - Number(r.dist)).toFixed(2)})` })),
        fts: lRes.rows.slice(0, 5).map(r => ({ form: r.form, entityId: r.entity_id, tag: '' })),
        tfidf: tfRows.slice(0, 5).map(r => ({ form: r.form, entityId: r.entityId, tag: ` (${r.score.toFixed(2)})` })),
        tfidf_char: tfcRows.slice(0, 5).map(r => ({ form: r.form, entityId: r.entityId, tag: ` (${r.score.toFixed(2)})` })),
      },
    });
    const push = (b: string) => { if (buckets[b].length < BUCKET_CAP) buckets[b].push(mk()); };
    if (denseHit && !ftsHit && !tfHit && !tfcHit) push('dense-only (all lexical methods miss)');
    if (!denseHit && (tfHit || tfcHit)) push('lexical-only (dense misses; word/char tfidf hits)');
    if (!tfHit && tfcHit) push('char-3gram rescue (word-tfidf misses; char-tfidf hits)');
    if (twin) push('label-noise: held-out form shared by ≥2 entities (KB dup/ambiguous)');

    if (++i % 200 === 0) console.log(`  …${i}/${qset.rows.length}`);
  }
  denseClient.release();

  const n = qset.rows.length;
  const report = buildReport('ke', n,
    {
      substrate: 'known_entities (name embeddings)',
      methods: 'dense | fts | tfidf(word) | tfidf_char(3gram) | hybrid(d+t) | hybrid3(d+t+c)',
      K_RETRIEVE, RRF_K0, HNSW_EF_SEARCH,
      'AUDIT — held-out form shared by ≥2 entities (label noise)': `${twinQ} (${(100 * twinQ / n).toFixed(1)}%)`,
      'AUDIT — dense top-1 is exact-text twin, different entity (KB dup/ambiguous)': denseTop1Twin,
      'AUDIT — hybrid3 @20 misses that carry an exact twin (label-induced)': missWithTwin,
    },
    aggs, ranks, 'hybrid3');
  console.log('\n' + report.md);
  writeResults('ke', report);
  writeDiscrepancies(buckets);
}

// ═══════════════════════════════════════════════════════════════════════════
//  junkaudit — how much of the entity KB / our eval is NON-entity (structured-
//  identity outcomes: candle windows, numeric thresholds) that should never have
//  been routed through the text-similarity entity resolver.
// ═══════════════════════════════════════════════════════════════════════════
function shapeCase(col: string): string {
  return `CASE
    WHEN ${col} ~* '(up or down|[0-9]{1,2}:[0-9]{2})' THEN 'candle-like'
    WHEN ${col} ~ '[0-9]' AND ${col} ~* '(above|below|under|over|at least|at most|or more|or above|or below|fewer than|greater than|less than|percentage point|° ?f?|[0-9] ?(k|m|pts|points|%))' THEN 'numeric/threshold'
    WHEN ${col} ~ '[0-9]' THEN 'other-with-digit'
    ELSE 'clean' END`;
}
async function runJunkAudit(pool: pg.Pool): Promise<void> {
  const report = async (label: string, sql: string) => {
    console.log(`\n${label}:`);
    const r = await pool.query(sql);
    for (const row of r.rows) console.log(`  ${String(row.bucket).padEnd(18)} ${String(row.n).padStart(7)}  ${row.pct}%`);
  };
  await report('known_entities by canonical shape (the `ke` corpus)',
    `SELECT bucket, count(*) n, round(100.0*count(*)/sum(count(*)) over(),1) pct
       FROM (SELECT ${shapeCase('lower(btrim(canonical))')} bucket FROM known_entities) t
      GROUP BY 1 ORDER BY 2 DESC`);
  await report('entity_subjects by canonical_subject shape',
    `SELECT bucket, count(*) n, round(100.0*count(*)/sum(count(*)) over(),1) pct
       FROM (SELECT ${shapeCase('lower(btrim(canonical_subject))')} bucket FROM entity_subjects) t
      GROUP BY 1 ORDER BY 2 DESC`);
  await report('ke LOO-eligible entities by canonical shape (= what our 89% was measured on)',
    `WITH elig AS (SELECT entity_id FROM bench_known_entity_forms GROUP BY 1 HAVING count(*) >= 2)
     SELECT bucket, count(*) n, round(100.0*count(*)/sum(count(*)) over(),1) pct FROM (
       SELECT ${shapeCase('lower(btrim(ke.canonical))')} bucket
       FROM known_entities ke JOIN elig ON elig.entity_id = ke.id) t
      GROUP BY 1 ORDER BY 2 DESC`);
  console.log('\n  examples of candle/numeric rows in known_entities:');
  const ex = await pool.query(
    `SELECT canonical, type FROM known_entities
      WHERE lower(canonical) ~* '(up or down|[0-9]{1,2}:[0-9]{2})'
         OR (canonical ~ '[0-9]' AND lower(canonical) ~* '(above|below|or more|pts|percentage point|° ?f|[0-9] ?k\\M)')
      ORDER BY md5(canonical) LIMIT 15`);
  for (const r of ex.rows) console.log(`    [${r.type}] ${r.canonical}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  kbaudit — verify KB duplicates from structure (no retrieval, no embeddings)
//  Uses known_entities' own (sport_canonical, league_canonical) scope columns to
//  separate REAL dups (same name + same scope) from legit same-name-diff-scope.
// ═══════════════════════════════════════════════════════════════════════════
async function runKbAudit(pool: pg.Pool): Promise<void> {
  const summary = await pool.query<{ colliding: number; rows_involved: number; same_scope: number; diff_scope: number }>(
    `WITH c AS (
       SELECT lower(btrim(canonical)) AS cf, count(*) AS n,
              count(DISTINCT coalesce(sport_canonical,'') || '|' || coalesce(league_canonical,'')) AS scopes
       FROM known_entities GROUP BY 1 HAVING count(*) > 1)
     SELECT count(*)::int AS colliding,
            coalesce(sum(n),0)::int AS rows_involved,
            count(*) FILTER (WHERE scopes = 1)::int AS same_scope,
            count(*) FILTER (WHERE scopes > 1)::int AS diff_scope
     FROM c`);
  const s = summary.rows[0];
  console.log('KB canonical collisions (same lowercased canonical under >1 entity_id):');
  console.log(`  colliding canonical strings : ${s.colliding}`);
  console.log(`  total rows involved         : ${s.rows_involved}`);
  console.log(`  SAME scope → real duplicate : ${s.same_scope}`);
  console.log(`  DIFF scope → legit (e.g. Phoenix NBA vs WNBA) : ${s.diff_scope}`);

  console.log('\n  worst same-scope dups (real merge gaps):');
  const dups = await pool.query<{ cf: string; n: number; ids: number[]; types: string[] }>(
    `SELECT lower(btrim(canonical)) AS cf, count(*)::int AS n,
            array_agg(id ORDER BY id) AS ids, array_agg(DISTINCT type) AS types
       FROM known_entities GROUP BY 1
      HAVING count(*) > 1
         AND count(DISTINCT coalesce(sport_canonical,'') || '|' || coalesce(league_canonical,'')) = 1
      ORDER BY count(*) DESC, cf LIMIT 25`);
  for (const r of dups.rows) console.log(`    "${r.cf}"  x${r.n}  ids=${r.ids.join(',')}  types=${r.types.join('/')}`);

  const shared = await pool.query<{ shared_forms: number; total_forms: number }>(
    `WITH forms AS (
       SELECT id AS eid, lower(btrim(canonical)) AS form FROM known_entities
       UNION ALL
       SELECT id, lower(btrim(jsonb_array_elements_text(aliases))) FROM known_entities)
     SELECT
       (SELECT count(*) FROM (SELECT form FROM forms WHERE length(form) > 0
                               GROUP BY form HAVING count(DISTINCT eid) > 1) t)::int AS shared_forms,
       (SELECT count(DISTINCT form) FROM forms WHERE length(form) > 0)::int AS total_forms`);
  const sh = shared.rows[0];
  console.log(`\n  surface forms shared across >1 entity (ambiguous OR dup): ${sh.shared_forms} / ${sh.total_forms} distinct (${(100 * sh.shared_forms / sh.total_forms).toFixed(1)}%)`);
}

// ═══════════════════════════════════════════════════════════════════════════
//  cross-platform event benchmark  (platform_events) — phase 2
// ═══════════════════════════════════════════════════════════════════════════
async function runEvents(pool: pg.Pool, sample: number): Promise<void> {
  const embn = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM platform_events WHERE embedding IS NOT NULL`);
  const embedded = parseInt(embn.rows[0].n, 10);
  console.log(`events: ${embedded} platform_events embedded`);
  if (embedded < 50) {
    console.log('Phase 2 not ready: platform_events.embedding still populating (Stage 2c). Re-run later.');
    return;
  }

  // Lexical TEMP index over event text (title + subject + participants).
  const lexClient = await pool.connect();
  await lexClient.query(`
    CREATE TEMP TABLE bench_evt ON COMMIT PRESERVE ROWS AS
      SELECT id, platform,
             to_tsvector('english',
               coalesce(title,'') || ' ' || coalesce(canonical_subject,'') || ' ' ||
               coalesce(array_to_string(participants, ' '), '')) AS tsv,
             coalesce(title,'') || ' ' || coalesce(canonical_subject,'') || ' ' ||
               coalesce(array_to_string(participants, ' '), '') AS rawtext
        FROM platform_events WHERE embedding IS NOT NULL`);
  await lexClient.query(`CREATE INDEX ON bench_evt USING gin(tsv)`);
  await lexClient.query(`ANALYZE bench_evt`);

  const denseClient = await pool.connect();
  await denseClient.query(`SET enable_seqscan = off`);
  await denseClient.query(`SET hnsw.ef_search = ${HNSW_EF_SEARCH}`);

  // Query set: embedded platform_events that HAVE a confirmed cross-platform sibling.
  // Ground truth here is the semantic_event_id (the "canonical" the methods must hit).
  const qset = await pool.query<{ id: number; platform: string; sem: number; emb: string; rawtext: string }>(
    `SELECT pe.id, pe.platform, sep.semantic_event_id AS sem, pe.embedding::text AS emb,
            coalesce(pe.title,'') || ' ' || coalesce(pe.canonical_subject,'') || ' ' ||
              coalesce(array_to_string(pe.participants,' '),'') AS rawtext
       FROM platform_events pe
       JOIN semantic_event_platforms sep ON sep.platform_event_id = pe.id
      WHERE pe.embedding IS NOT NULL
        AND sep.semantic_event_id IN (
          SELECT a.semantic_event_id
            FROM semantic_event_platforms a
            JOIN platform_events x ON x.id=a.platform_event_id AND x.embedding IS NOT NULL
           GROUP BY a.semantic_event_id
          HAVING count(DISTINCT x.platform) >= 2)
      ORDER BY md5(pe.id::text)
      LIMIT $1`,
    [sample],
  );
  console.log(`events: ${qset.rows.length} queries with a cross-platform sibling`);
  if (qset.rows.length === 0) {
    console.log('No confirmed cross-platform sibling pairs among embedded events yet.');
    lexClient.release(); denseClient.release();
    return;
  }

  // Map: semantic_event_id → set of embedded member platform_event ids (the truth set).
  const members = await pool.query<{ sem: number; pid: number }>(
    `SELECT sep.semantic_event_id AS sem, sep.platform_event_id AS pid
       FROM semantic_event_platforms sep
       JOIN platform_events pe ON pe.id=sep.platform_event_id AND pe.embedding IS NOT NULL`);
  const truthSet = new Map<number, Set<number>>();
  for (const r of members.rows) {
    if (!truthSet.has(r.sem)) truthSet.set(r.sem, new Set());
    truthSet.get(r.sem)!.add(r.pid);
  }

  const aggs = { dense: newAgg(), lexical: newAgg(), hybrid: newAgg() };
  const ranks: { dense: number; lexical: number; hybrid: number }[] = [];

  // For events the "canonical" is the semantic_event_id; a candidate is a true
  // match iff it is a (cross-platform) member of the query's semantic event.
  const scoreEvt = (agg: MethodAgg, list: { id: number; platform: string }[], q: { sem: number; platform: string }) => {
    const sibs = truthSet.get(q.sem)!;
    let rank = Infinity;
    for (let j = 0; j < list.length; j++) {
      if (list[j].platform !== q.platform && sibs.has(list[j].id) && list[j].id !== q.sem) { rank = j + 1; break; }
    }
    if (rank !== Infinity) { agg.mrrSum += 1 / rank; for (const k of KS) if (rank <= k) agg.recallAtK[k] += 1; }
    for (const k of KS) {
      agg.fpAtK[k] += list.slice(0, k).filter(c => !(c.platform !== q.platform && sibs.has(c.id))).length;
    }
    return rank;
  };

  let i = 0;
  for (const q of qset.rows) {
    const dRes = await denseClient.query<{ id: number; platform: string }>(
      `SELECT id, platform FROM platform_events
        WHERE id <> $2 AND platform <> $3 AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector LIMIT $4`,
      [q.emb, q.id, q.platform, K_RETRIEVE]);
    const dense = dRes.rows;

    const lRes = await lexClient.query<{ id: number; platform: string }>(
      `SELECT id, platform FROM bench_evt
        WHERE id <> $2 AND platform <> $3 AND tsv @@ plainto_tsquery('english', $1)
        ORDER BY ts_rank_cd(tsv, plainto_tsquery('english', $1)) DESC, id LIMIT $4`,
      [q.rawtext, q.id, q.platform, K_RETRIEVE]);
    const lexical = lRes.rows;

    const hyb = rrf(
      dense.map(r => ({ key: String(r.id), canonical: r.platform })),
      lexical.map(r => ({ key: String(r.id), canonical: r.platform })),
    ).map(c => ({ id: parseInt(c.key, 10), platform: c.canonical }));

    ranks.push({
      dense: scoreEvt(aggs.dense, dense, q),
      lexical: scoreEvt(aggs.lexical, lexical, q),
      hybrid: scoreEvt(aggs.hybrid, hyb, q),
    });
    if (++i % 100 === 0) console.log(`  …${i}/${qset.rows.length}`);
  }

  lexClient.release();
  denseClient.release();

  const report = buildReport('events', qset.rows.length,
    { substrate: 'platform_events', embedded, K_RETRIEVE, RRF_K0, HNSW_EF_SEARCH }, aggs, ranks);
  console.log('\n' + report.md);
  writeResults('events', report);
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const mode = process.argv[2] ?? 'stats';
  const sample = arg('sample', 500);
  const pool = makePool();
  try {
    if (mode === 'stats') await runStats(pool);
    else if (mode === 'entity') await runEntity(pool, sample);
    else if (mode === 'ke') await runKe(pool, sample);
    else if (mode === 'kbaudit') await runKbAudit(pool);
    else if (mode === 'junkaudit') await runJunkAudit(pool);
    else if (mode === 'events') await runEvents(pool, sample);
    else { console.error(`unknown mode: ${mode} (use: stats | entity | ke | kbaudit | events)`); process.exitCode = 1; }
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
