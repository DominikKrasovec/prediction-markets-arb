/**
 * Standalone benchmark: serial `solveLP` loop vs the `SolverPool.solveBatch`
 * worker path, over a HEAVY-TAILED batch that mimics one `solveDirty` drain in
 * the live run (~240 tiny LPs + a few dozen mid-size + a handful of deep ladder
 * LPs). Proves two things:
 *   (a) EQUALITY — every cluster's optimalCost + variable values are identical
 *       between the two paths (same WASM + same LP string + same parser ⇒
 *       bit-for-bit, within a tiny float tolerance for status/cost).
 *   (b) SPEEDUP — wall-time + throughput (solves/sec) of the pool vs serial.
 *
 * DB-less and flag-agnostic: it constructs LPProblems directly (via buildLP over
 * synthetic price caches, so the structures match production exactly) and drives
 * the pool explicitly. Run:
 *
 *   bun services/arb-solver/src/bench/solver-pool-bench.ts
 *   bun services/arb-solver/src/bench/solver-pool-bench.ts --workers=8 --reps=5
 *
 * Or against the compiled output (node dist):
 *   node services/arb-solver/dist/bench/solver-pool-bench.js
 */
import { performance } from 'node:perf_hooks';
import type { Platform } from '@arb/types';
import type { Cluster, MarketRef, QuestionNode } from '../graph/types.js';
import { PriceCache, type PriceUpdate } from '../clob/price-cache.js';
import { buildLP } from '../solver/lp-builder.js';
import { solveLP } from '../solver/solver.js';
import { SolverPool } from '../solver/solver-pool.js';
import type { LPProblem, LPResult } from '../solver/types.js';

// CLI args
const argOf = (name: string, dflt: number): number => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? parseInt(a.split('=')[1]) : dflt;
};
const WORKERS = argOf('workers', 0); // 0 ⟹ pool default (config.solver.workerCount)
const REPS = argOf('reps', 5);
const N_SMALL = argOf('small', 240);
const N_MID = argOf('mid', 28);
const N_LADDER = argOf('ladder', 4);

// LP construction (all via buildLP, so they match production shapes)

const yesLadderUpd = (
  marketId: number, bestBid: number, bestAsk: number,
  askLevels: Array<[number, number]>, bidLevels: Array<[number, number]>,
): PriceUpdate => ({
  marketId, platform: 'polymarket', bestBid, bestAsk,
  bidSize: bidLevels[0]?.[1] ?? 0, askSize: askLevels[0]?.[1] ?? 0,
  timestamp: Date.now(), askLevels, bidLevels,
});

let qidSeq = 1;
let midSeq = 1;

/** A SMALL 2-var arb LP: one question, one market, YES+NO top-of-book. */
function smallLP(): LPProblem {
  const qid = qidSeq++;
  const mid = midSeq++;
  const markets = new Map<number, MarketRef>([[mid, { marketId: mid, platform: 'polymarket' as Platform, platformId: `pid-${mid}` }]]);
  const q: QuestionNode = { questionId: qid, canonicalSubject: `s${qid}`, conditionShape: null, conditionValue: null, conditionDate: null, markets };
  const c: Cluster = {
    id: qid, questions: new Map([[qid, q]]), outcomeSets: [], edges: [],
    marketIds: new Set([mid]), validStates: [new Map([[qid, true]]), new Map([[qid, false]])], dirty: false,
  };
  const pc = new PriceCache();
  // Cheap arb (0.45 + synthetic 0.42) so the LP is Optimal & < $1.
  pc.update({ marketId: mid, platform: 'polymarket', bestBid: 0.58, bestAsk: 0.45, bidSize: 100, askSize: 100, timestamp: Date.now() });
  return buildLP(c, pc, { enforceFees: true, enforceDepthCap: true }, false, false)!;
}

/** A MID-size LP: one categorical-ish cluster of `markets` binary questions all
 *  in one component (≈ 2·markets vars + 2^? states bounded). To keep states
 *  small but vars ~targetVars, we use `markets` independent questions, each 1
 *  market (2 vars), and cap with a modest free-question count. */
function midLP(targetVars: number): LPProblem {
  const nMarkets = Math.max(1, Math.floor(targetVars / 2));
  const questions = new Map<number, QuestionNode>();
  const marketIds = new Set<number>();
  const pc = new PriceCache();
  // Single shared question with many markets → 2·nMarkets vars, only 2 states.
  const qid = qidSeq++;
  const markets = new Map<number, MarketRef>();
  for (let i = 0; i < nMarkets; i++) {
    const mid = midSeq++;
    markets.set(mid, { marketId: mid, platform: 'polymarket' as Platform, platformId: `pid-${mid}` });
    marketIds.add(mid);
    pc.update({ marketId: mid, platform: 'polymarket', bestBid: 0.40 + (i % 5) * 0.01, bestAsk: 0.50 + (i % 7) * 0.01, bidSize: 100, askSize: 100, timestamp: Date.now() });
  }
  const q: QuestionNode = { questionId: qid, canonicalSubject: `m${qid}`, conditionShape: null, conditionValue: null, conditionDate: null, markets };
  questions.set(qid, q);
  const c: Cluster = {
    id: qid, questions, outcomeSets: [], edges: [], marketIds,
    validStates: [new Map([[qid, true]]), new Map([[qid, false]])], dirty: false,
  };
  return buildLP(c, pc, { enforceFees: true, enforceDepthCap: true }, false, false)!;
}

/** A DEEP LADDER profit-max LP (~targetVars vars): one question with several
 *  markets, each carrying a many-level ask+bid ladder so buildLP tranches them
 *  and switches to the G-variable profit-max form. */
function ladderLP(targetVars: number): LPProblem {
  // Each market contributes ~2·levels vars (YES ask ladder + synthetic NO from
  // YES bid ladder). Spread across a few markets so the constraint matrix has a
  // couple of binding questions.
  const levelsPerLeg = 30;
  const nMarkets = Math.max(2, Math.ceil(targetVars / (2 * levelsPerLeg)));
  const qid = qidSeq++;
  const markets = new Map<number, MarketRef>();
  const marketIds = new Set<number>();
  const pc = new PriceCache();
  for (let m = 0; m < nMarkets; m++) {
    const mid = midSeq++;
    markets.set(mid, { marketId: mid, platform: 'polymarket' as Platform, platformId: `pid-${mid}` });
    marketIds.add(mid);
    // Build a deep, monotonic ask ladder (rising) and bid ladder (falling) so the
    // profit-max LP walks several levels before marginal cost hits $1.
    const askLevels: Array<[number, number]> = [];
    const bidLevels: Array<[number, number]> = [];
    for (let l = 0; l < levelsPerLeg; l++) {
      askLevels.push([Number((0.30 + l * 0.01).toFixed(4)), 50 + l]);
      bidLevels.push([Number((0.58 - l * 0.01).toFixed(4)), 50 + l]);
    }
    pc.update(yesLadderUpd(mid, bidLevels[0][0], askLevels[0][0], askLevels, bidLevels));
  }
  const q: QuestionNode = { questionId: qid, canonicalSubject: `L${qid}`, conditionShape: null, conditionValue: null, conditionDate: null, markets };
  const c: Cluster = {
    id: qid, questions: new Map([[qid, q]]), outcomeSets: [], edges: [], marketIds,
    validStates: [new Map([[qid, true]]), new Map([[qid, false]])], dirty: false,
  };
  return buildLP(c, pc, { enforceFees: true, enforceDepthCap: true }, true, true)!;
}

function buildBatch(): LPProblem[] {
  const lps: LPProblem[] = [];
  for (let i = 0; i < N_SMALL; i++) lps.push(smallLP());
  for (let i = 0; i < N_MID; i++) lps.push(midLP(200));
  for (let i = 0; i < N_LADDER; i++) lps.push(ladderLP(1200));
  return lps;
}

// equality check
function resultsEqual(a: LPResult, b: LPResult): boolean {
  if (a.status !== b.status) return false;
  if (a.status !== 'Optimal') return true; // non-optimal: status match is enough
  if (Math.abs(a.optimalCost - b.optimalCost) > 1e-9) return false;
  if (a.values.length !== b.values.length) return false;
  for (let i = 0; i < a.values.length; i++) {
    if (Math.abs((a.values[i] ?? 0) - (b.values[i] ?? 0)) > 1e-6) return false;
  }
  return true;
}

async function main(): Promise<void> {
  const lps = buildBatch();
  const nVars = lps.reduce((s, l) => s + l.numVars, 0);
  const maxVars = Math.max(...lps.map((l) => l.numVars));
  console.log(
    `Batch: ${lps.length} LPs (${N_SMALL} small + ${N_MID} mid@~200var + ${N_LADDER} ladder@~1200var) | ` +
    `total vars=${nVars} maxVars=${maxVars}`,
  );

  const pool = WORKERS > 0 ? new SolverPool(WORKERS) : new SolverPool();
  await pool.ready();
  console.log(`Worker pool: ${pool.size} workers`);

  // warm-up (JIT + WASM page-in on both paths)
  for (const lp of lps.slice(0, 8)) await solveLP(lp);
  await pool.solveBatch(lps.slice(0, 8));

  // equality (first rep)
  const serial0: LPResult[] = [];
  for (const lp of lps) serial0.push(await solveLP(lp));
  const parallel0 = await pool.solveBatch(lps);
  let mismatches = 0;
  for (let i = 0; i < lps.length; i++) {
    if (!resultsEqual(serial0[i], parallel0[i])) {
      mismatches++;
      if (mismatches <= 5) {
        console.error(
          `  MISMATCH cluster idx ${i} (vars=${lps[i].numVars}): ` +
          `serial{${serial0[i].status},${serial0[i].optimalCost}} vs parallel{${parallel0[i].status},${parallel0[i].optimalCost}}`,
        );
      }
    }
  }
  const equalityOk = mismatches === 0;
  console.log(`Equality: ${equalityOk ? 'PASS ✓ (all ' + lps.length + ' identical)' : 'FAIL ✗ (' + mismatches + ' mismatches)'}`);

  // timing (median of REPS)
  const serialTimes: number[] = [];
  const parallelTimes: number[] = [];
  for (let r = 0; r < REPS; r++) {
    let t = performance.now();
    for (const lp of lps) await solveLP(lp);
    serialTimes.push(performance.now() - t);

    t = performance.now();
    await pool.solveBatch(lps);
    parallelTimes.push(performance.now() - t);
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const sMed = median(serialTimes);
  const pMed = median(parallelTimes);

  console.log('');
  console.log(`Serial   (median of ${REPS}): ${sMed.toFixed(1)} ms  → ${(lps.length / (sMed / 1000)).toFixed(0)} solves/sec`);
  console.log(`Parallel (median of ${REPS}): ${pMed.toFixed(1)} ms  → ${(lps.length / (pMed / 1000)).toFixed(0)} solves/sec  [${pool.size} workers]`);
  console.log(`Speedup: ${(sMed / pMed).toFixed(2)}x`);
  console.log(`  serial   reps: [${serialTimes.map((x) => x.toFixed(0)).join(', ')}] ms`);
  console.log(`  parallel reps: [${parallelTimes.map((x) => x.toFixed(0)).join(', ')}] ms`);

  await pool.terminate();
  process.exit(equalityOk ? 0 : 1);
}

main().catch((err) => {
  console.error('bench error:', err);
  process.exit(2);
});
