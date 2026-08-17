/**
 * Ω-LP STRESS HARNESS
 * ===================
 * Drives the REAL production solver path on synthetic clusters of controlled
 * shape:  enumerateStates → buildLP → solveLP  (all imported from arb-solver/src,
 * unmodified). Decomposes wall time into 4 phases and isolates the HiGHS simplex
 * solve from the LP-format-string serialization (the production `solveLP` lumps
 * them together).
 *
 * The constraint matrix produced is the genuine 0/1 payout matrix (rows = valid
 * world states, cols = 2·markets YES/NO legs, payout ≥ $1). Prices are mocked but
 * structurally sound (ask∈(0,1), bid=ask−spread, NO synthesized 1−bid), with
 * controllable arb structure.
 *
 * Levers, controlled INDEPENDENTLY:
 *   #states (rows)  ← cluster archetype (free 2^f / categorical k / cartesian)
 *   #vars   (cols)  ← 2·Σ(markets per question); inflate via decoy markets (M>1)
 *                     WITHOUT changing the row count.
 *   arb density     ← price structure (none / thin / fat).
 *
 * Usage:  node --expose-gc --import tsx data/omega-stress/harness.ts <exp> [args]
 *   exp ∈ { rows-free, rows-cat, cols, arb-density, enum, batch, smoke }
 *
 * Output: CSV per experiment under data/omega-stress/results/.
 */
import 'dotenv/config';
import { writeFileSync, appendFileSync } from 'node:fs';
import type { Cluster, QuestionNode, OutcomeSetRef, EdgeRef, MarketRef } from '../../services/arb-solver/src/graph/types.ts';
import { enumerateStates } from '../../services/arb-solver/src/solver/state-enumerator.ts';
import { buildLP } from '../../services/arb-solver/src/solver/lp-builder.ts';
import { solveLP } from '../../services/arb-solver/src/solver/solver.ts';
import { NO_EXECUTION_GATE } from '../../services/arb-solver/src/solver/types.ts';
import type { LPProblem } from '../../services/arb-solver/src/solver/types.ts';
import { PriceCache } from '../../services/arb-solver/src/clob/price-cache.ts';

// ───────────────────────────── HiGHS (decomposition) ─────────────────────────
interface HighsInstance { solve(problem: string, options?: Record<string, unknown>): any; }
let highsInstance: HighsInstance | null = null;
async function getHiGHS(): Promise<HighsInstance> {
  if (!highsInstance) {
    const mod = await import('highs');
    const loader = (mod.default as any) as (opts?: any) => Promise<HighsInstance>;
    highsInstance = await loader();
  }
  return highsInstance!;
}

/** Verbatim copy of solver.ts buildLPString — used to time serialization alone. */
function buildLPString(problem: LPProblem): string {
  const lines: string[] = ['Minimize'];
  const objTerms: string[] = [];
  for (let i = 0; i < problem.numVars; i++) {
    const coeff = problem.objective[i];
    if (coeff !== 0) objTerms.push(`${coeff} x${i}`);
  }
  lines.push(`  obj: ${objTerms.join(' + ') || '0'}`);
  lines.push('Subject To');
  for (let s = 0; s < problem.constraints.length; s++) {
    const row = problem.constraints[s];
    const terms: string[] = [];
    for (let i = 0; i < problem.numVars; i++) {
      if (row[i] !== 0) terms.push(`${row[i]} x${i}`);
    }
    if (terms.length > 0) lines.push(`  s${s}: ${terms.join(' + ')} >= ${problem.rhs[s]}`);
  }
  lines.push('Bounds');
  for (let i = 0; i < problem.numVars; i++) {
    const cap = problem.variables[i]?.maxShares;
    if (cap != null && Number.isFinite(cap)) lines.push(`  0 <= x${i} <= ${cap}`);
    else lines.push(`  x${i} >= 0`);
  }
  lines.push('End');
  return lines.join('\n');
}

// ───────────────────────────── deterministic RNG ─────────────────────────────
// mulberry32 — no Date/Math.random dependence; reproducible across runs.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────────── synthetic clusters ────────────────────────────
type Archetype = 'free' | 'categorical' | 'cartesian';
type ArbMode = 'none' | 'thin' | 'fat';

interface ClusterSpec {
  archetype: Archetype;
  /** free: number of independent binary questions (states=2^f).
   *  categorical: slot count k (states=k if exhaustive else k+1).
   *  cartesian: per-set slot count k, with `sets` sets (states=(k+1)^sets). */
  size: number;
  sets?: number;             // cartesian only
  exhaustive?: boolean;      // categorical/cartesian
  marketsPerQuestion: number; // M ≥ 1 — decoy legs inflate cols, not rows
  arb: ArbMode;
  seed: number;
}

let QID = 1, MID = 1, SID = 1;

/**
 * Build a Cluster + a populated PriceCache for a spec. Prices are sound:
 * categorical/cartesian sets get YES asks summing to the arb target (Σ<1 ⟹ a
 * buy-all-YES arb exists; Σ>1 ⟹ none); free questions get any ask (no single
 * market can arb because NO=1−bid ⟹ ask_yes+ask_no=1+spread>1).
 */
function makeCluster(spec: ClusterSpec): { cluster: Cluster; price: PriceCache } {
  const r = rng(spec.seed);
  const price = new PriceCache();
  const questions = new Map<number, QuestionNode>();
  const marketIds = new Set<number>();
  const outcomeSets: OutcomeSetRef[] = [];
  const edges: EdgeRef[] = [];
  const TS = 1_000_000; // fixed, non-stale (TTL=∞)

  // Arb structure of a one-hot set is governed by the SUM of YES asks AND the
  // SUM of YES bids (no-arb ⟺ Σbid ≤ 1 ≤ Σask — both sides, because the NO-
  // basket [buy NO on every slot, k−1 always pay] is a second covering strategy
  // the LP will exploit). We therefore control Σask and Σspread (⟹ Σbid) per arb
  // mode so the per-slot spread shrinks with k but the SUMS keep the margin:
  //   none: Σask=1.20, Σbid=0.80 (clean no-arb both sides)
  //   thin: Σask=0.99 (1% buy-all-YES arb)    fat: Σask=0.85 (15% arb)
  const askSum = spec.arb === 'fat' ? 0.85 : spec.arb === 'thin' ? 0.99 : 1.20;
  const spreadSum = spec.arb === 'none' ? 0.40 : 0.10;

  const addMarket = (qNode: QuestionNode, askYes: number, spread: number) => {
    for (let m = 0; m < spec.marketsPerQuestion; m++) {
      const mid = MID++;
      // bid = ask − spread, kept strictly ≤ ask (a valid book) WITHOUT bumping
      // ask. The earlier `Math.max(bid+0.001, askYes)` enforced a 0.001 min gap
      // that, for large k (per-slot spread < 0.001), silently lifted every ask
      // and pushed Σask above 1 — destroying the intended arb. We instead floor
      // the bid just below ask, leaving Σask = askSum exactly.
      const ask = Math.min(0.999, askYes);
      const bid = Math.max(0.0005, Math.min(ask - spread, ask - 1e-6));
      const ref: MarketRef = { marketId: mid, platform: 'kalshi', platformId: `syn-${mid}`, endDateMs: null, negRiskEventId: null };
      qNode.markets.set(mid, ref);
      marketIds.add(mid);
      price.update({ marketId: mid, platform: 'kalshi', bestBid: bid, bestAsk: ask, bidSize: 100 + Math.floor(r() * 400), askSize: 100 + Math.floor(r() * 400), timestamp: TS });
    }
  };

  const newQuestion = (): QuestionNode => {
    const qid = QID++;
    const node: QuestionNode = { questionId: qid, canonicalSubject: `syn-${qid}`, conditionShape: null, conditionValue: null, conditionDate: null, markets: new Map() };
    questions.set(qid, node);
    return node;
  };

  if (spec.archetype === 'free') {
    const f = spec.size;
    for (let i = 0; i < f; i++) {
      const q = newQuestion();
      // independent prices; no single-market arb (NO=1−bid ⟹ ask+ask_no>1)
      addMarket(q, 0.2 + r() * 0.6, 0.005 + r() * 0.02);
    }
  } else {
    // categorical or cartesian: build `sets` one-hot sets of `k` slots each.
    const sets = spec.archetype === 'cartesian' ? (spec.sets ?? 2) : 1;
    const k = spec.size;
    for (let s = 0; s < sets; s++) {
      const slotQids: number[] = [];
      const base = askSum / k;        // Σask = askSum across the set
      const spread = spreadSum / k;   // Σspread = spreadSum across the set
      for (let i = 0; i < k; i++) {
        const q = newQuestion();
        slotQids.push(q.questionId);
        const jitter = (r() - 0.5) * base * 0.3; // sums ≈0 → preserves Σask
        // floor 0.001 (one Polymarket tick) keeps the Σ-target arb structure
        // intact up to k≈800 for fat; beyond that per-slot prices hit the floor
        // and a buy-all-YES arb is no longer representable (a real-world fact for
        // huge one-hot fields — Σask≈1+vig). Timing is unaffected either way.
        addMarket(q, Math.min(0.97, Math.max(0.001, base + jitter)), spread);
      }
      outcomeSets.push({ setId: SID++, setType: 'categorical', setName: `set-${s}`, slotQuestionIds: slotQids, isExhaustive: spec.exhaustive ?? true });
    }
  }

  const cluster: Cluster = { id: 1, questions, outcomeSets, edges, marketIds, validStates: [], dirty: true };
  return { cluster, price };
}

// ───────────────────────────── timing helpers ────────────────────────────────
function gc() { if ((global as any).gc) (global as any).gc(); }
function now() { return performance.now(); }
function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
function pct(xs: number[], p: number): number { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; }

interface Phase { enumMs: number; buildLpMs: number; strMs: number; highsMs: number; solveLpMs: number; }

/**
 * One full measured pass on a prebuilt cluster (states precomputed once).
 * `callRealSolve` also invokes the production `solveLP` (string+solve+extract)
 * for fidelity; skipped on huge configs to halve peak memory — there the
 * primary measurement is our own buildLPString + highs.solve (byte-identical
 * string format + same WASM solver), and solveLpMs is derived as str+highs.
 */
// Size guards (empirically: HiGHS WASM aborts reading an LP string ≳ 160 MB;
// V8 OOMs building the dense matrix past ~1.6 GB). We SKIP past these and RECORD
// the wall rather than crash — the skip IS the finding.
const SKIP_BUILD_CELLS = 200_000_000; // dense matrix cells (states·2·markets) → ~1.6 GB
const SKIP_STR_BYTES = 300_000_000;   // don't even serialize past this
const SKIP_SOLVE_BYTES = 150_000_000; // don't hand HiGHS WASM a string past this (it aborts)

async function measureOnce(cluster: Cluster, price: PriceCache, states: any[], callRealSolve = true): Promise<{ phase: Phase; status: string; cost: number; numVars: number; numRows: number; nnz: number; lpBytes: number }> {
  cluster.validStates = states;
  const markets = cluster.marketIds.size;
  const numVars = 2 * markets;
  const numRows = states.length;
  const estNnz = numRows * markets;            // each constraint row ≈ #markets nonzeros
  const estBytes = estNnz * 11 + numVars * 14; // LP-format character estimate

  // Pre-build guard: don't allocate a matrix that will OOM the process.
  if (numRows * numVars > SKIP_BUILD_CELLS) {
    return { phase: { enumMs: 0, buildLpMs: NaN, strMs: NaN, highsMs: NaN, solveLpMs: NaN }, status: 'SKIP_BUILD', cost: NaN, numVars, numRows, nnz: estNnz, lpBytes: estBytes };
  }

  const tb = now();
  const lp = buildLP(cluster, price, NO_EXECUTION_GATE)!;
  const buildLpMs = now() - tb;

  let strMs = NaN, highsMs = NaN, solveLpMs = NaN, status = 'SKIP_STR', cost = NaN, lpBytes = estBytes;

  if (estBytes <= SKIP_STR_BYTES) {
    const ts = now();
    const lpStr = buildLPString(lp);
    strMs = now() - ts;
    lpBytes = lpStr.length;

    if (lpStr.length <= SKIP_SOLVE_BYTES) {
      const highs = await getHiGHS();
      const th = now();
      try {
        const res = highs.solve(lpStr);
        highsMs = now() - th;
        status = res?.Status ?? 'Error';
        cost = res?.ObjectiveValue ?? Infinity;
        solveLpMs = strMs + highsMs;
      } catch {
        highsMs = now() - th;
        status = 'ABORT';        // HiGHS WASM aborted reading the LP string
        highsInstance = null;    // dead module → force reload on next solve
      }
      // production solveLP fidelity check (small/medium only)
      if (callRealSolve && status !== 'ABORT') {
        const tsolve = now();
        try {
          const real = await solveLP(lp);
          solveLpMs = now() - tsolve;
          status = real.status; cost = real.optimalCost;
        } catch { highsInstance = null; }
      }
    } else {
      status = 'SKIP_SOLVE';     // string built (timed) but too big to hand HiGHS
    }
  } else {
    status = 'SKIP_STR';         // too big to even serialize
  }

  // exact nnz only when cheap to count
  let nnz = estNnz;
  if (numRows * numVars < 5_000_000 && status !== 'SKIP_BUILD') {
    nnz = 0; for (const row of lp.constraints) for (const v of row) if (v !== 0) nnz++;
  }

  return { phase: { enumMs: 0, buildLpMs, strMs, highsMs, solveLpMs }, status, cost, numVars, numRows, nnz, lpBytes };
}

const heapMB = () => process.memoryUsage().heapUsed / 1e6;
const rssMB = () => process.memoryUsage().rss / 1e6;
const HEAP_STOP_MB = 5200;          // stop escalating a sweep past this heap use
const PERCONFIG_STOP_MS = 90_000;   // stop escalating once a config exceeds this
const FIDELITY_MAX_STATES = 60_000; // call real solveLP only at/below this size
const CAP_BIG = 64_000_000;         // enumerator maxStates override (>> prod 10k); memory is the real wall
const RESULTS = 'data/omega-stress/results';

// ───────────────────────────── experiments ───────────────────────────────────

async function expRowsFree() {
  // Free archetype: states = 2^f, vars = 2·f·M. Sweep f UNHINGED until the
  // memory wall. M=1 (minimal vars) isolates pure ROW scaling — the cleanest
  // "max states" curve. No arb possible (cost ≈ 1+min spread).
  const out = `${RESULTS}/rows-free.csv`;
  writeFileSync(out, 'archetype,f,marketsPerQ,states,vars,nnz,lpBytes,enumMs,buildLpMs,strMs,highsMs,solveLpMs,totalMs,heapMB,rssMB,status,cost\n');
  const fs = [1, 2, 3, 4, 6, 8, 10, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
  for (const f of fs) {
    const M = 1;
    QID = 1; MID = 1; SID = 1;
    const { cluster, price } = makeCluster({ archetype: 'free', size: f, marketsPerQuestion: M, arb: 'none', seed: 12345 + f });
    gc();
    const te = now();
    let states: any[];
    try { states = enumerateStates(cluster, { maxStates: CAP_BIG, clusterSizeCap: 1e9 }); }
    catch (e) { console.log(`f=${f} enum threw: ${(e as Error).message}`); break; }
    const enumMs = now() - te;
    if (states.length === 0) { console.log(`f=${f}: enumerator returned 0 (cap) — states would be ${2 ** f}`); appendFileSync(out, `free,${f},${M},${2 ** f},,,,${enumMs.toFixed(2)},,,,,,,,DROPPED,\n`); continue; }
    const fidelity = states.length <= FIDELITY_MAX_STATES;
    await measureOnce(cluster, price, states, fidelity); // warmup
    const reps = states.length > 500000 ? 1 : states.length > 50000 ? 2 : states.length > 5000 ? 3 : 6;
    const acc: any[] = [];
    for (let i = 0; i < reps; i++) { acc.push(await measureOnce(cluster, price, states, fidelity)); gc(); }
    const m = acc[0];
    const med = (k: keyof Phase) => median(acc.map(a => a.phase[k]));
    const total = enumMs + med('buildLpMs') + med('solveLpMs');
    const hp = heapMB(), rs = rssMB();
    appendFileSync(out, `free,${f},${M},${states.length},${m.numVars},${m.nnz},${m.lpBytes},${enumMs.toFixed(2)},${med('buildLpMs').toFixed(2)},${med('strMs').toFixed(2)},${med('highsMs').toFixed(2)},${med('solveLpMs').toFixed(2)},${total.toFixed(2)},${hp.toFixed(0)},${rs.toFixed(0)},${m.status},${m.cost.toFixed(4)}\n`);
    console.log(`free f=${f} states=${states.length} vars=${m.numVars} | enum=${enumMs.toFixed(0)} buildLP=${med('buildLpMs').toFixed(1)} str=${med('strMs').toFixed(1)} highs=${med('highsMs').toFixed(1)} solveLP=${med('solveLpMs').toFixed(1)} | heap=${hp.toFixed(0)} rss=${rs.toFixed(0)}MB | ${m.status} cost=${Number.isFinite(m.cost) ? m.cost.toFixed(3) : m.status}`);
    states.length = 0; gc(); // release the 2^f state Maps before the next config
    if (m.status.startsWith('SKIP') || m.status === 'ABORT') { console.log(`  hit ${m.status} wall — stopping free sweep`); break; }
    if (total > PERCONFIG_STOP_MS) { console.log('  >90s — stopping free sweep'); break; }
    if (hp > HEAP_STOP_MB) { console.log(`  heap ${hp.toFixed(0)}MB > ${HEAP_STOP_MB} — stopping before OOM`); break; }
  }
}

async function expRowsCat() {
  // Categorical archetype: states = k, vars = 2·k (coupled — the REAL-cluster
  // regime, vars≈states). Sweep k unhinged. arb none vs fat. Matrix ~k×2k=2k²,
  // so this walls earlier than free (cols grow with rows).
  const out = `${RESULTS}/rows-cat.csv`;
  writeFileSync(out, 'archetype,k,arb,states,vars,nnz,lpBytes,enumMs,buildLpMs,strMs,highsMs,solveLpMs,totalMs,heapMB,rssMB,status,cost\n');
  const ks = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192];
  for (const arb of ['none', 'fat'] as ArbMode[]) {
    for (const k of ks) {
      QID = 1; MID = 1; SID = 1;
      const { cluster, price } = makeCluster({ archetype: 'categorical', size: k, exhaustive: true, marketsPerQuestion: 1, arb, seed: 777 + k });
      gc();
      const te = now();
      const states = enumerateStates(cluster, { maxStates: CAP_BIG, clusterSizeCap: 1e9 });
      const enumMs = now() - te;
      if (states.length === 0) { console.log(`cat k=${k}: 0 states`); continue; }
      const fidelity = states.length <= FIDELITY_MAX_STATES;
      await measureOnce(cluster, price, states, fidelity);
      const reps = states.length > 8000 ? 2 : states.length > 1000 ? 3 : 6;
      const acc: any[] = [];
      for (let i = 0; i < reps; i++) { acc.push(await measureOnce(cluster, price, states, fidelity)); gc(); }
      const m = acc[0];
      const med = (kk: keyof Phase) => median(acc.map(a => a.phase[kk]));
      const total = enumMs + med('buildLpMs') + med('solveLpMs');
      const hp = heapMB(), rs = rssMB();
      appendFileSync(out, `categorical,${k},${arb},${states.length},${m.numVars},${m.nnz},${m.lpBytes},${enumMs.toFixed(2)},${med('buildLpMs').toFixed(2)},${med('strMs').toFixed(2)},${med('highsMs').toFixed(2)},${med('solveLpMs').toFixed(2)},${total.toFixed(2)},${hp.toFixed(0)},${rs.toFixed(0)},${m.status},${m.cost.toFixed(4)}\n`);
      console.log(`cat k=${k} arb=${arb} states=${states.length} vars=${m.numVars} | buildLP=${med('buildLpMs').toFixed(1)} str=${med('strMs').toFixed(1)} highs=${med('highsMs').toFixed(1)} solveLP=${med('solveLpMs').toFixed(1)} | rss=${rs.toFixed(0)}MB | ${m.status} cost=${Number.isFinite(m.cost) ? m.cost.toFixed(3) : m.status}`);
      if (m.status === 'SKIP_BUILD' || m.status === 'ABORT' || total > PERCONFIG_STOP_MS || hp > HEAP_STOP_MB) { console.log(`  ${m.status} — next arb mode`); break; }
    }
  }
}

async function expCols() {
  // Fix states via free f, sweep vars via marketsPerQuestion M UNHINGED.
  // Isolates COL scaling at fixed row count.
  const out = `${RESULTS}/cols.csv`;
  writeFileSync(out, 'fixedStates,f,marketsPerQ,states,vars,nnz,lpBytes,buildLpMs,strMs,highsMs,solveLpMs,rssMB,status,cost\n');
  for (const f of [6, 10, 13]) { // states 64, 1024, 8192
    for (const M of [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]) {
      QID = 1; MID = 1; SID = 1;
      const { cluster, price } = makeCluster({ archetype: 'free', size: f, marketsPerQuestion: M, arb: 'none', seed: 5000 + f * 100 + M });
      gc();
      const states = enumerateStates(cluster, { maxStates: CAP_BIG, clusterSizeCap: 1e9 });
      if (states.length === 0) continue;
      const fidelity = states.length * M <= FIDELITY_MAX_STATES;
      await measureOnce(cluster, price, states, fidelity);
      const acc: any[] = [];
      for (let i = 0; i < 5; i++) { acc.push(await measureOnce(cluster, price, states, fidelity)); gc(); }
      const m = acc[0];
      const med = (k: keyof Phase) => median(acc.map(a => a.phase[k]));
      const rs = rssMB();
      appendFileSync(out, `${2 ** f},${f},${M},${states.length},${m.numVars},${m.nnz},${m.lpBytes},${med('buildLpMs').toFixed(2)},${med('strMs').toFixed(2)},${med('highsMs').toFixed(2)},${med('solveLpMs').toFixed(2)},${rs.toFixed(0)},${m.status},${m.cost.toFixed(4)}\n`);
      console.log(`cols states=${2 ** f} M=${M} vars=${m.numVars} | buildLP=${med('buildLpMs').toFixed(1)} str=${med('strMs').toFixed(1)} highs=${med('highsMs').toFixed(1)} solveLP=${med('solveLpMs').toFixed(1)} | rss=${rs.toFixed(0)}MB | ${m.status}`);
      if (m.status.startsWith('SKIP') || m.status === 'ABORT' || rs > 9000) { console.log(`  ${m.status} — next state size`); break; }
    }
  }
}

async function expArbDensity() {
  // Fixed dims, vary arb structure, many repeats → distribution of solve time.
  const out = `${RESULTS}/arb-density.csv`;
  writeFileSync(out, 'k,states,vars,arb,rep,buildLpMs,strMs,highsMs,solveLpMs,status,cost\n');
  for (const k of [16, 64, 256, 512, 1024, 2048]) {
    for (const arb of ['none', 'thin', 'fat'] as ArbMode[]) {
      QID = 1; MID = 1; SID = 1;
      const { cluster, price } = makeCluster({ archetype: 'categorical', size: k, exhaustive: true, marketsPerQuestion: 1, arb, seed: 99 + k });
      const states = enumerateStates(cluster, { maxStates: CAP_BIG, clusterSizeCap: 1e9 });
      await measureOnce(cluster, price, states); // warmup
      const reps = k > 2000 ? 8 : 20;
      for (let i = 0; i < reps; i++) {
        const m = await measureOnce(cluster, price, states);
        appendFileSync(out, `${k},${states.length},${m.numVars},${arb},${i},${m.phase.buildLpMs.toFixed(3)},${m.phase.strMs.toFixed(3)},${m.phase.highsMs.toFixed(3)},${m.phase.solveLpMs.toFixed(3)},${m.status},${m.cost.toFixed(4)}\n`);
      }
      const verdict = (await measureOnce(cluster, price, states));
      console.log(`arb-density k=${k} arb=${arb} states=${states.length} → ${verdict.status} cost=${verdict.cost.toFixed(3)} (${verdict.cost < 1 ? 'ARB' : 'no-arb'})`);
    }
  }
}

async function expEnum() {
  // Enumeration-only scaling (the once-per-graph-load cost). free vs cartesian.
  const out = `${RESULTS}/enum.csv`;
  writeFileSync(out, 'archetype,param,states,vars,enumMs,heapMB\n');
  for (const f of [8, 10, 12, 14, 16, 17, 18, 19, 20, 21]) {
    QID = 1; MID = 1; SID = 1;
    const { cluster } = makeCluster({ archetype: 'free', size: f, marketsPerQuestion: 1, arb: 'none', seed: 1 });
    gc();
    const t = now();
    let states: any[] = [];
    try { states = enumerateStates(cluster, { maxStates: CAP_BIG, clusterSizeCap: 1e9 }); }
    catch (e) { console.log(`enum free f=${f} threw ${(e as Error).message}`); break; }
    const ms = now() - t;
    const hp = heapMB();
    const nStates = states.length;
    appendFileSync(out, `free,${f},${nStates || 2 ** f},${2 * f},${ms.toFixed(2)},${hp.toFixed(1)}\n`);
    console.log(`enum free f=${f} states=${nStates} enumMs=${ms.toFixed(1)} heap=${hp.toFixed(0)}MB`);
    states = []; gc();  // free the 2^f Maps before the next (bigger) allocation
    // projected next step ≈ 2× heap; stop before it can OOM the 6 GB cap.
    if (ms > 30000 || nStates === 0 || hp > 3500) break;
  }
  // cartesian: (k+1)^sets states with moderate vars
  for (const [k, sets] of [[10, 3], [30, 3], [50, 3], [99, 3], [30, 4], [50, 4]] as [number, number][]) {
    QID = 1; MID = 1; SID = 1;
    const { cluster } = makeCluster({ archetype: 'cartesian', size: k, sets, exhaustive: true, marketsPerQuestion: 1, arb: 'none', seed: 2 });
    gc();
    const t = now();
    const states = enumerateStates(cluster, { maxStates: CAP_BIG, clusterSizeCap: 1e9 });
    const ms = now() - t;
    const heapMB = process.memoryUsage().heapUsed / 1e6;
    appendFileSync(out, `cartesian-${sets},${k},${states.length},${2 * k * sets},${ms.toFixed(2)},${heapMB.toFixed(1)}\n`);
    console.log(`enum cartesian k=${k} sets=${sets} states=${states.length} enumMs=${ms.toFixed(1)} heap=${heapMB.toFixed(0)}MB`);
  }
}

async function smoke() {
  // Sanity: tiny categorical with a fat arb must report cost<1; no-arb cost>1.
  for (const arb of ['fat', 'none'] as ArbMode[]) {
    QID = 1; MID = 1; SID = 1;
    const { cluster, price } = makeCluster({ archetype: 'categorical', size: 5, exhaustive: true, marketsPerQuestion: 1, arb, seed: 42 });
    const states = enumerateStates(cluster, { maxStates: 10000, clusterSizeCap: 200 });
    const m = await measureOnce(cluster, price, states);
    console.log(`smoke cat k=5 arb=${arb}: states=${states.length} vars=${m.numVars} status=${m.status} cost=${m.cost.toFixed(4)} → ${m.cost < 1 ? 'ARB ✓' : 'no-arb'}`);
  }
  // free 3 → 8 states, no arb
  QID = 1; MID = 1; SID = 1;
  const { cluster, price } = makeCluster({ archetype: 'free', size: 3, marketsPerQuestion: 2, arb: 'none', seed: 7 });
  const states = enumerateStates(cluster, { maxStates: 10000, clusterSizeCap: 200 });
  const m = await measureOnce(cluster, price, states);
  console.log(`smoke free f=3 M=2: states=${states.length} (expect 8) vars=${m.numVars} (expect 12) status=${m.status} cost=${m.cost.toFixed(4)}`);
}

async function main() {
  const exp = process.argv[2] ?? 'smoke';
  console.log(`=== Ω-LP STRESS: ${exp} === (gc=${(global as any).gc ? 'on' : 'off'})`);
  const t0 = now();
  const run = async (name: string, fn: () => Promise<void>) => {
    console.log(`\n##### EXPERIMENT: ${name} @ ${((now() - t0) / 1000).toFixed(1)}s #####`);
    const s = now();
    try { await fn(); } catch (e) { console.error(`${name} FAILED: ${(e as Error).message}`); }
    console.log(`##### ${name} done in ${((now() - s) / 1000).toFixed(1)}s #####`);
    gc();
  };
  switch (exp) {
    case 'rows-free': await expRowsFree(); break;
    case 'rows-cat': await expRowsCat(); break;
    case 'cols': await expCols(); break;
    case 'arb-density': await expArbDensity(); break;
    case 'enum': await expEnum(); break;
    case 'smoke': await smoke(); break;
    case 'all':
      // memory-hungry rows-free LAST so an OOM there can't kill earlier CSVs.
      await run('smoke', smoke);
      await run('arb-density', expArbDensity);
      await run('enum', expEnum);
      await run('rows-cat', expRowsCat);
      await run('cols', expCols);
      await run('rows-free', expRowsFree);
      break;
    case 'rest': // everything except the already-captured enum sweep
      await run('arb-density', expArbDensity);
      await run('rows-cat', expRowsCat);
      await run('cols', expCols);
      await run('rows-free', expRowsFree);
      break;
    default: console.log(`unknown exp ${exp}`);
  }
  console.log(`done in ${((now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
