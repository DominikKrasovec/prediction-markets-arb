/**
 * TIER-B ECONOMIC REPLAY — re-derives every soak-era arbitrage floor from
 * scratch on the FINAL (patched) constraint graph, using the real solver and
 * the order books logged at the moment of the max-profit fire. Runs the
 * production per-cluster path verbatim so every runtime belt gets its chance
 * to refuse the trade, then compares the fresh floor against the soak-era
 * `maxProfit`. Zero API cost, read-only, no writes to solver state.
 *
 * Two harness-only deviations from production, both conservative (more
 * constraints, never fewer):
 * (A) AS-OF LIVENESS — the loader's `now()` is frozen at the soak start
 *     (TIERB_ASOF) via a `pg` client SQL-text shim, so the graph contains
 *     every market live at any point in the window (the most-refusing version).
 * (B) COMPONENT-SCOPED LOAD — the loader's question query is restricted to
 *     the connected-component closure of the episodes' markets (fixpoint over
 *     the same adjacency relations cluster-builder.ts uses), so the solved
 *     clusters are bit-for-bit what a full load would have produced.
 *
 * Run: node --max-old-space-size=14000 --import tsx services/arb-solver/src/bench/replay-soak.ts
 */
import { readFileSync, writeFileSync, existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import pg from 'pg';
import type { Cluster } from '../graph/types.js';

// Set BEFORE any module that snapshots process.env at import time (config.ts
// is a frozen const). dotenv loads .env WITHOUT override, so these win.
const ASOF = process.env.TIERB_ASOF ?? '2026-07-15T17:05:21Z';
const REPLAY_DIR = process.env.TIERB_DIR ?? './replay';
const REPLAY_ALL_DIR = process.env.TIERB_DIR_ALL ?? './replay-all';
const QUESTION_CAP = 2000;

Object.assign(process.env, {
  // Replay DB (5434). The dev DB on 5433 is FORBIDDEN for this run.
  PG_HOST: 'localhost',
  PG_PORT: '5434',
  PG_DATABASE: 'prediction_arb',
  PG_USER: 'arb',
  PG_PASSWORD: 'arb_local_dev',
  SOLVE_ENGINE: 'facet',
  SOLVE_MAX_VALID_STATES: '2000',
  SOLVE_RELAXED_ROUTE: '0',
  SOLVE_MIN_EDGE_CONFIDENCE: '0.70',
  SOLVE_FACET_CLUSTER_QUESTION_CAP: String(QUESTION_CAP),
  // '1' (default) walks real book depth; TIERB_LADDER=0 restricts every leg to
  // top of book, which is the depth-sensitivity counterfactual.
  CLOB_BOOK_LADDER: process.env.TIERB_LADDER ?? '1',
  // Each episode is an independent one-shot solve.
  SOLVE_WORKER_POOL: '0',
  SOLVE_SERIAL_DEDUP: '0',
  SOLVE_SKIP_FILTER: '0',
  CLOB_LIVE_SUBSCRIBE_GATE: '0',
  REST_CROSSCHECK: '0',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
});

interface Settlement {
  status: 'open' | 'partial' | 'confirmed-win' | 'confirmed-loss';
  realizedPayout: number | null;
  cost: number | null;
  realizedPnL?: number;
  flags: string[];
  backtested: boolean;
  disputed: boolean;
}
interface Episode {
  fingerprint: string;
  tier: string;
  subjects: string[];
  platforms: string[];
  Mtraded: number[];
  Mcluster: number[];
  structureCategory: string;
  fireCount: number;
  maxProfit: number;
  maxProfitTs: string;
  settlement: Settlement;
}
interface LoggedBook {
  bestBid: number;
  bestAsk: number;
  bidSize: number;
  askSize: number;
  lastUpdate: number;
  staleSince?: number | null;
  askLevels?: Array<[number, number]>;
  bidLevels?: Array<[number, number]>;
}
interface FireRecord {
  ts: string;
  clusterId: number;
  optimalCost: number;
  stateCount: number;
  portfolio: { profit: number; legs: Array<{ marketId: number }> } | null;
  clusterMarkets: Array<{
    marketId: number;
    platform: string;
    yesBook: LoggedBook | null;
    noBook: LoggedBook | null;
  }>;
}

const readJsonl = <T>(path: string): T[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);

async function loadBooks(fps: Set<string>): Promise<Map<string, FireRecord>> {
  const out = new Map<string, FireRecord>();
  for (const dir of [REPLAY_DIR, REPLAY_ALL_DIR]) {
    const path = `${dir}/episodes-books.jsonl`;
    if (!existsSync(path)) continue;
    const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }) });
    for await (const line of rl) {
      if (line.trim().length === 0) continue;
      const o = JSON.parse(line) as { fingerprint: string; record: FireRecord };
      if (fps.has(o.fingerprint) && !out.has(o.fingerprint)) out.set(o.fingerprint, o.record);
    }
  }
  return out;
}

// Cached on disk between runs.
async function computeClosure(seedMarkets: number[]): Promise<number[]> {
  const cachePath = `${REPLAY_DIR}/_tierb-closure.json`;
  if (existsSync(cachePath)) {
    const c = JSON.parse(readFileSync(cachePath, 'utf8')) as { asof: string; qids: number[] };
    if (c.asof === ASOF) {
      console.log(`closure: reusing cache (${c.qids.length} questions)`);
      return c.qids;
    }
  }
  const client = new pg.Client({
    host: 'localhost', port: 5434, database: 'prediction_arb',
    user: 'arb', password: 'arb_local_dev', statement_timeout: 1_800_000,
  });
  await client.connect();
  const t0 = Date.now();
  const AS = `timestamptz '${ASOF}'`;
  await client.query(`CREATE TEMP TABLE lq AS
     SELECT q.id FROM questions q
     WHERE q.archived_at IS NULL AND EXISTS (
       SELECT 1 FROM question_members qm JOIN markets m ON m.id = qm.market_id
       WHERE qm.question_id = q.id AND m.resolved_at IS NULL
         AND (m.end_date IS NULL OR m.end_date > ${AS}))`);
  await client.query('CREATE UNIQUE INDEX ON lq(id)');
  await client.query(`CREATE TEMP TABLE le AS
     SELECT e.antecedent_question_id a, e.consequent_question_id b
     FROM implication_edges e JOIN lq la ON la.id = e.antecedent_question_id
     JOIN lq lc ON lc.id = e.consequent_question_id
     WHERE e.confidence >= 0.70 AND e.archived_at IS NULL`);
  await client.query('CREATE INDEX ON le(a)');
  await client.query('CREATE INDEX ON le(b)');
  await client.query(`CREATE TEMP TABLE ls AS
     SELECT s.set_id, s.question_id FROM outcome_set_slots s JOIN lq ON lq.id = s.question_id`);
  await client.query('CREATE INDEX ON ls(set_id)');
  await client.query('CREATE INDEX ON ls(question_id)');
  await client.query('CREATE TEMP TABLE comp (id int primary key)');
  await client.query(
    `INSERT INTO comp SELECT DISTINCT qm.question_id FROM question_members qm
     JOIN lq ON lq.id = qm.question_id WHERE qm.market_id = ANY($1) ON CONFLICT DO NOTHING`,
    [seedMarkets],
  );
  let prev = -1;
  for (let i = 0; i < 60; i++) {
    const n = (await client.query('SELECT count(*)::int n FROM comp')).rows[0].n as number;
    if (n === prev) break;
    prev = n;
    await client.query('INSERT INTO comp SELECT DISTINCT b FROM le JOIN comp ON comp.id = le.a ON CONFLICT DO NOTHING');
    await client.query('INSERT INTO comp SELECT DISTINCT a FROM le JOIN comp ON comp.id = le.b ON CONFLICT DO NOTHING');
    await client.query(`INSERT INTO comp SELECT DISTINCT s2.question_id FROM ls s1
       JOIN comp ON comp.id = s1.question_id JOIN ls s2 ON s2.set_id = s1.set_id ON CONFLICT DO NOTHING`);
  }
  const qids = (await client.query('SELECT id FROM comp ORDER BY id')).rows.map((r) => r.id as number);
  await client.end();
  console.log(`closure: ${qids.length} questions (fixpoint) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  writeFileSync(cachePath, JSON.stringify({ asof: ASOF, qids }));
  return qids;
}

// Rewrites ONLY the loader's liveness predicate; every other statement
// passes through byte-identical.
const LIVE_PRED = 'AND (m.end_date IS NULL OR m.end_date > now())';
function installPgShim(scopeQids: number[]): void {
  const replacement =
    `AND (m.end_date IS NULL OR m.end_date > timestamptz '${ASOF}')` +
    ` AND qm.question_id = ANY('{${scopeQids.join(',')}}'::int[])`;
  const rewrite = (text: string): string =>
    text.includes(LIVE_PRED) ? text.split(LIVE_PRED).join(replacement) : text;
  const orig = pg.Client.prototype.query as (...a: unknown[]) => unknown;
  let hits = 0;
  (pg.Client.prototype as unknown as { query: unknown }).query = function (
    this: unknown, cfg: unknown, ...rest: unknown[]
  ) {
    if (typeof cfg === 'string') {
      const t = rewrite(cfg);
      if (t !== cfg) hits++;
      cfg = t;
    } else if (cfg && typeof (cfg as { text?: unknown }).text === 'string') {
      const c = cfg as { text: string };
      const t = rewrite(c.text);
      if (t !== c.text) { hits++; cfg = { ...c, text: t }; }
    }
    return orig.call(this, cfg, ...rest);
  };
  process.on('exit', () => console.log(`pg shim: rewrote ${hits} loader statement(s)`));
}

// Quote-age/TOB-age TTLs are evaluated against Date.now(); replaying an old
// book today would age every quote out, so each solve pins Date.now() to
// that episode's fire timestamp (restored immediately after).
const REAL_NOW: () => number = Date.now.bind(Date);
function withClock<T>(at: number, fn: () => T): T {
  Date.now = () => at;
  try {
    return fn();
  } finally {
    Date.now = REAL_NOW;
  }
}
async function withClockAsync<T>(at: number, fn: () => Promise<T>): Promise<T> {
  Date.now = () => at;
  try {
    return await fn();
  } finally {
    Date.now = REAL_NOW;
  }
}

type Verdict =
  | 'CONFIRMED-FLOOR' | 'REDUCED-FLOOR' | 'INCREASED' | 'NO-PORTFOLIO' | 'UNVERIFIABLE';

interface OutRow {
  fingerprint: string;
  verdict: Verdict;
  recordedFloor: number;
  freshFloor: number;
  /** Bound capital of the fresh portfolio (fees included). 0 when none. */
  freshCost: number;
  freshGrade: string | null;
  reasons: string[];
  refusalReason: string | null;
  refusalClass: string | null;
  /** Diagnostic only (under-booked clusters): floor with the quoted-fraction
   *  perf floor removed. null ⟹ probe not run. */
  probeFloor: number | null;
  probeGrade: string | null;
  probeRefusal: string | null;
  clusterSize: number;
  clusterCount: number;
  stateCount: number;
  relaxed: boolean;
  degenerate: boolean;
  quotedFraction: number | null;
  /** Fraction of the new cluster's markets this episode logged a book for. */
  bookCoverage: number | null;
  mtradedCovered: number;
  mtradedTotal: number;
  legsFresh: number;
  legsRecorded: number;
  settlementStatus: string;
  disputed: boolean;
  realizedPnL: number | null;
  structureCategory: string;
  platforms: string[];
  solveMs: number;
}

async function main(): Promise<void> {
  const tStart = REAL_NOW();
  const all = readJsonl<Episode>(`${REPLAY_DIR}/sound-arbs.jsonl`);
  // TIERB_LIMIT smoke-runs the first N episodes; the closure/seed set is
  // always computed from the FULL episode list so clusters match a full run.
  const limit = parseInt(process.env.TIERB_LIMIT ?? '0', 10);
  const episodes = limit > 0 ? all.slice(0, limit) : all;
  console.log(`episodes: ${episodes.length}${limit > 0 ? ` (limited from ${all.length})` : ''}`);
  const books = await loadBooks(new Set(episodes.map((e) => e.fingerprint)));
  console.log(`books: ${books.size}/${episodes.length} fingerprints resolved`);

  const seedMarkets = [...new Set(all.flatMap((e) => e.Mtraded))];
  const closure = await computeClosure(seedMarkets);
  installPgShim(closure);

  // Dynamic imports ONLY after the env + shim are in place.
  const { config } = await import('../config.js');
  const { loadClusterGraph, prepareClusterForSolve, solveProblem } = await import('../solve-core.js');
  const { extractPortfolio } = await import('../solver/portfolio.js');
  const { checkFiredPortfolioTripwires } = await import('../solver/omega-audit.js');
  const { PriceCache } = await import('../clob/price-cache.js');
  const { endPool } = await import('@arb/db');

  console.log(
    `config: engine=${config.solver.engine} maxStates=${config.solver.maxStates} ` +
      `relaxedRoute=${config.solver.relaxedRoute} minEdgeConf=${config.solver.minEdgeConfidence} ` +
      `pg=${config.pg.host}:${config.pg.port} ladder=${process.env.CLOB_BOOK_LADDER}`,
  );

  const tLoad = REAL_NOW();
  const { clusters, marketClusterIndex } = await loadClusterGraph(config);
  console.log(
    `graph: ${clusters.length} clusters, ${marketClusterIndex.size} markets, ` +
      `loaded in ${((Date.now() - tLoad) / 1000).toFixed(0)}s`,
  );

  // Shared across episodes exactly as the daemon shares its module-level maps.
  const livenessMasks = new Map<number, string>();
  const dualCerts = new Map<number, never>();
  const lastSolveFingerprint = new Map<number, string>();
  const theta = 1 - config.solver.minProfit;

  const rows: OutRow[] = [];
  let done = 0;

  for (const ep of episodes) {
    const rec = books.get(ep.fingerprint)!;
    const now = Date.parse(rec.ts);
    const tEp = REAL_NOW();

    const epClusters = new Map<number, Cluster>();
    let covered = 0;
    for (const mid of ep.Mtraded) {
      const c = marketClusterIndex.get(mid);
      if (c) { covered++; epClusters.set(c.id, c); }
    }

    const base: OutRow = {
      fingerprint: ep.fingerprint,
      verdict: 'NO-PORTFOLIO',
      recordedFloor: ep.maxProfit,
      freshFloor: 0,
      freshCost: 0,
      freshGrade: null,
      reasons: [],
      refusalReason: null,
      refusalClass: null,
      probeFloor: null,
      probeGrade: null,
      probeRefusal: null,
      clusterSize: 0,
      clusterCount: epClusters.size,
      stateCount: 0,
      relaxed: false,
      degenerate: false,
      quotedFraction: null,
      bookCoverage: null,
      mtradedCovered: covered,
      mtradedTotal: ep.Mtraded.length,
      legsFresh: 0,
      legsRecorded: rec.portfolio?.legs.length ?? 0,
      settlementStatus: ep.settlement.status,
      disputed: ep.settlement.disputed === true,
      realizedPnL: ep.settlement.realizedPnL ?? null,
      structureCategory: ep.structureCategory,
      platforms: ep.platforms,
      solveMs: 0,
    };

    if (epClusters.size === 0) {
      base.refusalReason = 'no-cluster-covers-traded-markets';
      base.refusalClass = 'traded-legs-dropped-from-graph';
      rows.push(base);
      if (++done % 50 === 0) console.log(`… ${done}/${episodes.length}`);
      continue;
    }

    // A basket cannot span clusters, so the floor is the best single-cluster floor.
    let best: {
      floor: number; cost: number; grade: string; reasons: string[]; cluster: Cluster;
      states: number; legs: number; qf: number | null; refusal: string | null;
    } | null = null;
    let anyRefusal: string | null = null;
    let overCap = false;
    let underBooked = false;
    let bestCoverage = 0;
    const declined: Cluster[] = [];

    // Shared by the primary pass and the diagnostic pass so both run identical code.
    const solveCluster = async (
      cluster: Cluster,
      execution: typeof config.execution,
    ): Promise<
      | { ok: true; floor: number; cost: number; grade: string; reasons: string[]; states: number; legs: number; qf: number | null }
      | { ok: false; refusal: string; declined: boolean }
    > => {
      const cache = new PriceCache();
      cache.setTtl(config.execution.quoteTtlMs);
      cache.setTobTtl(config.execution.tobTtlMs);
      for (const [, q] of cluster.questions) for (const [mid] of q.markets) cache.track(mid);
      for (const cm of rec.clusterMarkets) {
        if (!cluster.marketIds.has(cm.marketId)) continue;
        const pf = cm.platform as Parameters<typeof cache.update>[0]['platform'];
        if (cm.yesBook) {
          cache.update({
            marketId: cm.marketId, platform: pf,
            bestBid: cm.yesBook.bestBid, bestAsk: cm.yesBook.bestAsk,
            bidSize: cm.yesBook.bidSize, askSize: cm.yesBook.askSize,
            timestamp: cm.yesBook.lastUpdate, outcome: 'yes',
            askLevels: cm.yesBook.askLevels, bidLevels: cm.yesBook.bidLevels,
          });
        }
        if (cm.noBook) {
          cache.update({
            marketId: cm.marketId, platform: pf,
            bestBid: cm.noBook.bestBid, bestAsk: cm.noBook.bestAsk,
            bidSize: cm.noBook.bidSize, askSize: cm.noBook.askSize,
            timestamp: cm.noBook.lastUpdate, outcome: 'no',
            askLevels: cm.noBook.askLevels, bidLevels: cm.noBook.bidLevels,
          });
        }
      }

      const prep = withClock(now, () => prepareClusterForSolve(
        { priceCache: cache, lastSolveFingerprint, dualCerts: dualCerts as never, livenessMasks },
        cluster.id, cluster, now,
        { dedup: false, skipFilter: false, theta, execution, engine: config.solver.engine },
      ));
      if (prep.kind !== 'solve') {
        if (prep.kind === 'skip-quoted-fraction') {
          return {
            ok: false, declined: true,
            refusal: `skip-quoted-fraction(q=${prep.quotedFraction.toFixed(3)})`,
          };
        }
        return { ok: false, declined: false, refusal: cluster.degenerate ? 'degenerate-omega' : 'no-lp' };
      }
      const result = await withClockAsync(now, () => solveProblem(prep.lp));
      if (result.status !== 'Optimal') return { ok: false, declined: false, refusal: `lp-${result.status}` };
      const portfolio = withClock(now, () => extractPortfolio(
        result, prep.lp, cluster, cache, config.solver.minProfit,
        execution.gradeThresholds, now,
        { maxStates: config.solver.maxStates, clusterSizeCap: config.solver.clusterSizeCap },
      ));
      if (!portfolio) return { ok: false, declined: false, refusal: 'no-arb-at-logged-books' };
      if (portfolio.executionGrade === 'blocked') {
        return { ok: false, declined: false, refusal: `blocked: ${portfolio.executionReasons.join(' | ')}` };
      }
      const trips = withClock(now, () => checkFiredPortfolioTripwires(
        cluster, prep.lp.variables, portfolio.omegaAudit, cache, now, portfolio.executionGrade,
      ));
      if (trips.length > 0) return { ok: false, declined: false, refusal: `tripwire: ${trips.join(' ; ')}` };
      return {
        ok: true,
        floor: portfolio.profit,
        cost: portfolio.totalCost,
        grade: portfolio.executionGrade,
        reasons: portfolio.executionReasons,
        states: cluster.validStates.length,
        legs: portfolio.legs.length,
        qf: portfolio.omegaAudit?.quotedFraction ?? null,
      };
    };

    for (const cluster of epClusters.values()) {
      if (cluster.questions.size > QUESTION_CAP) { overCap = true; continue; }

      let booked = 0;
      for (const cm of rec.clusterMarkets) if (cluster.marketIds.has(cm.marketId)) booked++;
      const coverage = cluster.marketIds.size > 0 ? booked / cluster.marketIds.size : 0;
      if (coverage > bestCoverage) bestCoverage = coverage;

      const r = await solveCluster(cluster, config.execution);
      if (!r.ok) {
        if (r.declined) {
          // Not a soundness refusal; under-coverage is a harness artifact, so
          // re-probe below with the quoted-fraction floor removed.
          anyRefusal ??= `${r.refusal.slice(0, -1)},books=${coverage.toFixed(3)})`;
          if (coverage < 1) { underBooked = true; declined.push(cluster); }
        } else {
          anyRefusal ??= r.refusal;
        }
        continue;
      }
      if (!best || r.floor > best.floor) best = { ...r, cluster, refusal: null };
    }

    if (best) {
      base.freshFloor = best.floor;
      base.freshCost = best.cost;
      base.freshGrade = best.grade;
      base.reasons = best.reasons;
      base.clusterSize = best.cluster.questions.size;
      base.stateCount = best.states;
      base.relaxed = best.cluster.relaxed === true;
      base.degenerate = best.cluster.degenerate === true;
      base.quotedFraction = best.qf;
      base.bookCoverage = bestCoverage;
      base.legsFresh = best.legs;
      const tol = Math.max(0.01, 0.005 * Math.abs(ep.maxProfit));
      base.verdict =
        best.floor > ep.maxProfit + tol ? 'INCREASED'
          : best.floor >= ep.maxProfit - tol ? 'CONFIRMED-FLOOR'
            : 'REDUCED-FLOOR';
    } else {
      const c = [...epClusters.values()][0];
      base.clusterSize = c.questions.size;
      base.stateCount = c.validStates.length;
      base.relaxed = c.relaxed === true;
      base.degenerate = c.degenerate === true;
      base.bookCoverage = bestCoverage;

      // Diagnostic pass: re-run under-booked clusters with the quoted-fraction
      // floor removed to see what the graph would say. Never changes the primary verdict.
      for (const cluster of declined) {
        const r = await solveCluster(cluster, { ...config.execution, quotedFractionSolveFloor: 0 });
        if (r.ok && (base.probeFloor == null || r.floor > base.probeFloor)) {
          base.probeFloor = r.floor;
          base.probeGrade = r.grade;
          base.probeRefusal = null;
        } else if (!r.ok) {
          base.probeFloor ??= 0;
          base.probeRefusal ??= r.refusal;
        }
      }

      const lp = anyRefusal ?? (overCap ? 'over-question-cap' : 'no-arb-at-logged-books');
      base.refusalClass =
        overCap && !anyRefusal ? 'over-question-cap'
          : underBooked ? 'book-coverage-below-solve-floor'
            : covered < ep.Mtraded.length ? 'traded-legs-dropped-from-graph'
              : epClusters.size > 1 ? 'basket-split-across-clusters'
                : lp.startsWith('blocked') ? 'grade-blocked'
                  : lp.startsWith('tripwire') ? 'tripwire'
                    : lp.startsWith('degenerate') ? 'degenerate-omega'
                      : 'no-arb-at-logged-books';
      base.refusalReason =
        (covered < ep.Mtraded.length ? `traded legs ${covered}/${ep.Mtraded.length} in graph; ` : '') +
        (epClusters.size > 1 ? `basket split across ${epClusters.size} clusters; ` : '') + lp;
      // UNVERIFIABLE = the harness couldn't put the question to the graph;
      // everything else is a genuine refusal at the logged books.
      base.verdict = (overCap && !anyRefusal) || underBooked ? 'UNVERIFIABLE' : 'NO-PORTFOLIO';
    }
    base.solveMs = REAL_NOW() - tEp;
    rows.push(base);
    if (++done % 50 === 0) {
      console.log(`… ${done}/${episodes.length} (${((Date.now() - tStart) / 1000).toFixed(0)}s)`);
    }
  }

  writeFileSync(`${REPLAY_DIR}/tierb-results.jsonl`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(`${REPLAY_DIR}/tierb-summary.md`, renderSummary(rows, episodes, Date.now() - tStart));
  console.log(`\nwrote ${REPLAY_DIR}/tierb-results.jsonl + tierb-summary.md`);
  await endPool();
}

const usd = (n: number): string =>
  (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function renderSummary(rows: OutRow[], episodes: Episode[], ms: number): string {
  const L: string[] = [];
  const VERDICTS: Verdict[] = ['CONFIRMED-FLOOR', 'INCREASED', 'REDUCED-FLOOR', 'NO-PORTFOLIO', 'UNVERIFIABLE'];
  const sum = (xs: OutRow[], f: (r: OutRow) => number) => xs.reduce((a, r) => a + f(r), 0);

  L.push('# Tier-B economic replay — floors re-derived on the final patched graph');
  L.push('');
  L.push(`_Generated ${new Date().toISOString()} · ${rows.length} episodes · runtime ${(ms / 60000).toFixed(1)} min._`);
  L.push('');
  L.push('Every episode was re-solved from scratch with the production engine (facet LP,');
  L.push('`SOLVE_MAX_VALID_STATES=2000`, `SOLVE_RELAXED_ROUTE=0`, confidence floor 0.70,');
  L.push('`CLOB_BOOK_LADDER=1`) against the FINAL patched graph and the order books logged at');
  L.push('the episode\'s own max-profit fire. `freshFloor` is the guaranteed profit the sound');
  L.push('structure certifies at those books; `recordedFloor` is the soak-era `maxProfit`.');
  L.push('');

  L.push('## 1. Verdicts');
  L.push('');
  L.push('| verdict | episodes | recorded $ | fresh $ | Δ$ |');
  L.push('|---|---:|---:|---:|---:|');
  for (const v of VERDICTS) {
    const xs = rows.filter((r) => r.verdict === v);
    if (xs.length === 0) continue;
    const rec = sum(xs, (r) => r.recordedFloor), fr = sum(xs, (r) => r.freshFloor);
    L.push(`| ${v} | ${xs.length} | ${usd(rec)} | ${usd(fr)} | ${usd(fr - rec)} |`);
  }
  const recAll = sum(rows, (r) => r.recordedFloor), frAll = sum(rows, (r) => r.freshFloor);
  L.push(`| **TOTAL** | **${rows.length}** | **${usd(recAll)}** | **${usd(frAll)}** | **${usd(frAll - recAll)}** |`);
  L.push('');

  L.push('## 2. By settlement status');
  L.push('');
  L.push('| bucket | episodes | recorded $ | fresh $ | confirmed | increased | reduced | no-portfolio | unverif. |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  const buckets = ['confirmed-win', 'partial', 'open', 'confirmed-loss'];
  for (const b of buckets) {
    const xs = rows.filter((r) => r.settlementStatus === b);
    if (xs.length === 0) continue;
    const c = (v: Verdict) => xs.filter((r) => r.verdict === v).length;
    L.push(
      `| ${b} | ${xs.length} | ${usd(sum(xs, (r) => r.recordedFloor))} | ${usd(sum(xs, (r) => r.freshFloor))} | ` +
        `${c('CONFIRMED-FLOOR')} | ${c('INCREASED')} | ${c('REDUCED-FLOOR')} | ${c('NO-PORTFOLIO')} | ${c('UNVERIFIABLE')} |`,
    );
  }
  L.push('');

  const open = rows.filter((r) => r.settlementStatus === 'open');
  const openRec = sum(open, (r) => r.recordedFloor), openFresh = sum(open, (r) => r.freshFloor);
  L.push('## 3. The corrected OPEN bucket (update-ready)');
  L.push('');
  L.push(`| | episodes | value |`);
  L.push('|---|---:|---:|');
  L.push(`| open, soak-era floors (published) | ${open.length} | ${usd(openRec)} |`);
  L.push(`| open, FRESH floors on the sound graph | ${open.filter((r) => r.freshFloor > 0).length} surviving | ${usd(openFresh)} |`);
  L.push(`| **delta** | | **${usd(openFresh - openRec)}** (${(100 * (openFresh - openRec) / openRec).toFixed(1)}%) |`);
  L.push('');
  const survTotal = sum(rows.filter((r) => r.settlementStatus !== 'confirmed-loss'), (r) => r.freshFloor);
  L.push(`Headline total re-derived: ${usd(frAll)} across ${rows.filter((r) => r.freshFloor > 0).length} episodes ` +
    `(was ${usd(recAll)} / ${rows.length}); excluding the confirmed-loss cohort: ${usd(survTotal)}.`);
  L.push('');

  L.push('## 4. By structure category');
  L.push('');
  L.push('| structure | episodes | recorded $ | fresh $ | Δ$ | no-portfolio |');
  L.push('|---|---:|---:|---:|---:|---:|');
  for (const cat of [...new Set(rows.map((r) => r.structureCategory))].sort()) {
    const xs = rows.filter((r) => r.structureCategory === cat);
    const rec = sum(xs, (r) => r.recordedFloor), fr = sum(xs, (r) => r.freshFloor);
    L.push(`| ${cat} | ${xs.length} | ${usd(rec)} | ${usd(fr)} | ${usd(fr - rec)} | ${xs.filter((r) => r.verdict === 'NO-PORTFOLIO').length} |`);
  }
  L.push('');

  const calib = rows.filter((r) => r.settlementStatus === 'confirmed-win' && !r.disputed);
  const viol = calib.filter((r) => r.realizedPnL != null && r.freshFloor > r.realizedPnL + 0.01)
    .sort((a, b) => (b.freshFloor - (b.realizedPnL ?? 0)) - (a.freshFloor - (a.realizedPnL ?? 0)));
  L.push('## 5. Calibration set (settlement-confirmed, non-disputed)');
  L.push('');
  L.push(`${calib.length} episodes. A TRUE floor can never exceed the realised P&L at the same sizes,`);
  L.push('so `freshFloor > realizedPnL` would indicate a harness bug or residual graph unsoundness.');
  L.push('');
  L.push(`- violations: **${viol.length}** / ${calib.length}`);
  const exact = calib.filter((r) => r.verdict === 'CONFIRMED-FLOOR');
  L.push(`- floors reproduced exactly on the sound graph: ${exact.length} (${usd(sum(exact, (r) => r.freshFloor))})`);
  const refusedPaid = calib.filter((r) => r.freshFloor === 0 && (r.realizedPnL ?? 0) > 0);
  L.push(`- RECALL LOSS — refused by the sound graph but the reconstructed position DID pay: ` +
    `${refusedPaid.length} episodes, ${usd(sum(refusedPaid, (r) => r.realizedPnL ?? 0))} realised ` +
    `(the conservative direction: a refusal costs recall, never money).`);
  if (refusedPaid.length > 0) {
    const cls = new Map<string, number>();
    for (const r of refusedPaid) cls.set(r.refusalClass ?? '?', (cls.get(r.refusalClass ?? '?') ?? 0) + 1);
    L.push(`  - by cause: ${[...cls.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  if (viol.length > 0) {
    L.push('');
    L.push('| fingerprint | freshFloor | realizedPnL | excess | grade | structure |');
    L.push('|---|---:|---:|---:|---|---|');
    for (const r of viol.slice(0, 20)) {
      L.push(`| \`${r.fingerprint.slice(0, 12)}\` | ${usd(r.freshFloor)} | ${usd(r.realizedPnL ?? 0)} | ` +
        `${usd(r.freshFloor - (r.realizedPnL ?? 0))} | ${r.freshGrade} | ${r.structureCategory} |`);
    }
  }
  L.push('');

  // Disputed cohort
  const disp = rows.filter((r) => r.disputed).sort((a, b) => b.recordedFloor - a.recordedFloor);
  L.push('## 6. Disputed cohort');
  L.push('');
  L.push(`${disp.length} episodes flagged \`disputed\` at settlement — the sound graph should REFUSE`);
  L.push('them or cut their floor sharply.');
  L.push('');
  L.push('| fingerprint | status | recorded | fresh | verdict | reason / grade |');
  L.push('|---|---|---:|---:|---|---|');
  for (const r of disp) {
    L.push(`| \`${r.fingerprint.slice(0, 12)}\` | ${r.settlementStatus} | ${usd(r.recordedFloor)} | ${usd(r.freshFloor)} | ` +
      `${r.verdict} | ${(r.refusalReason ?? r.freshGrade ?? '—').slice(0, 90)} |`);
  }
  L.push('');

  // Largest moves
  L.push('## 7. Largest floor corrections');
  L.push('');
  L.push('| fingerprint | subject | recorded | fresh | Δ | verdict | reason |');
  L.push('|---|---|---:|---:|---:|---|---|');
  const byMove = [...rows].sort((a, b) => (a.freshFloor - a.recordedFloor) - (b.freshFloor - b.recordedFloor));
  const subj = new Map(episodes.map((e) => [e.fingerprint, (e.subjects[0] ?? '').slice(0, 34)]));
  for (const r of byMove.slice(0, 25)) {
    L.push(`| \`${r.fingerprint.slice(0, 12)}\` | ${subj.get(r.fingerprint)} | ${usd(r.recordedFloor)} | ${usd(r.freshFloor)} | ` +
      `${usd(r.freshFloor - r.recordedFloor)} | ${r.verdict} | ${(r.refusalReason ?? r.freshGrade ?? '—').slice(0, 60)} |`);
  }
  L.push('');

  // Refusal taxonomy
  L.push('## 8. Refusal taxonomy (NO-PORTFOLIO / UNVERIFIABLE)');
  L.push('');
  const tax = new Map<string, { n: number; usd: number }>();
  for (const r of rows) {
    if (r.verdict !== 'NO-PORTFOLIO' && r.verdict !== 'UNVERIFIABLE') continue;
    const key = r.refusalClass ?? 'unknown';
    const e = tax.get(key) ?? { n: 0, usd: 0 };
    e.n++; e.usd += r.recordedFloor; tax.set(key, e);
  }
  L.push('| reason | episodes | recorded $ withdrawn |');
  L.push('|---|---:|---:|');
  for (const [k, v] of [...tax.entries()].sort((a, b) => b[1].usd - a[1].usd)) {
    L.push(`| ${k} | ${v.n} | ${usd(v.usd)} |`);
  }
  L.push('');
  L.push('## 9. Book coverage of the new clusters');
  L.push('');
  const cov = rows.map((r) => r.bookCoverage).filter((c): c is number => c != null).sort((a, b) => a - b);
  const q = (p: number) => (cov.length ? cov[Math.floor(p * (cov.length - 1))] : NaN);
  L.push('Each episode\'s log captured the books of its SOAK-ERA cluster. Where the final graph');
  L.push('merged additional markets into that cluster, those extra books are unknown and are');
  L.push('replayed as unquoted (conservative for the LP, but it can also push a cluster under the');
  L.push('`quotedFractionSolveFloor`, which is why those episodes are reported UNVERIFIABLE rather');
  L.push('than as refusals).');
  L.push('');
  L.push(`- coverage (logged books / new-cluster markets): p10 ${(100 * q(0.1)).toFixed(0)}% · median ` +
    `${(100 * q(0.5)).toFixed(0)}% · p90 ${(100 * q(0.9)).toFixed(0)}%`);
  L.push(`- episodes with FULL coverage: ${cov.filter((c) => c >= 0.999).length} / ${cov.length}`);
  L.push('');
  const probed = rows.filter((r) => r.probeFloor != null);
  if (probed.length > 0) {
    const probeArb = probed.filter((r) => (r.probeFloor ?? 0) > 0);
    L.push(`**Diagnostic re-probe** (quoted-fraction PERF floor removed — it is documented as`);
    L.push('perf/noise hygiene, not soundness; the Ω-audit still grades and can still refuse):');
    L.push('');
    L.push('| fingerprint | recorded | probe floor | probe grade / refusal |');
    L.push('|---|---:|---:|---|');
    for (const r of [...probed].sort((a, b) => b.recordedFloor - a.recordedFloor)) {
      L.push(`| \`${r.fingerprint.slice(0, 12)}\` | ${usd(r.recordedFloor)} | ${usd(r.probeFloor ?? 0)} | ` +
        `${(r.probeGrade ?? r.probeRefusal ?? '—').slice(0, 70)} |`);
    }
    L.push('');
    L.push(`Even with the floor removed, ${probed.length - probeArb.length}/${probed.length} of these still`);
    L.push(`certify nothing; the ${probeArb.length} that do total ${usd(sum(probeArb, (r) => r.probeFloor ?? 0))} ` +
      `against ${usd(sum(probed, (r) => r.recordedFloor))} recorded.`);
  }
  L.push('');
  L.push('---');
  L.push('');
  L.push('_Harness: `services/arb-solver/src/bench/replay-soak.ts`. Read-only on the replay DB');
  L.push('(localhost:5434). Loader liveness frozen at the soak start and the load scoped to the');
  L.push('connected-component closure of the episodes\' markets — see the file header for why both');
  L.push('are conservative (more constraints, never fewer)._');
  return L.join('\n') + '\n';
}

main().catch((e) => { console.error(e); process.exit(1); });
