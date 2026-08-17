/**
 * LP-READER LINE-LENGTH BUG PROBE
 * ================================
 * The arb-density sweep showed a clean, correct optimum for small one-hot
 * categoricals (k≤64) but a WRONG optimum (no-arb reported on a 15%-underpriced
 * field) for k≥256. The `highs` wrapper's `solve(string)` writes the LP to a
 * WASM virtual file and parses it with `Highs_readModel` (the .lp text reader).
 * Hypothesis: HiGHS's LP reader truncates physical lines past some buffer, so a
 * constraint/objective line with many terms loses terms → wrong LP → wrong cost.
 *
 * This probe builds a categorical fat-arb LP at increasing k, records the
 * longest LP line, the reported optimum, and whether it matches the TRUE optimum
 * (buy-all-YES = Σask = 0.85). It then RE-EMITS the identical LP with terms
 * wrapped across multiple physical lines (free LP format allows continuation)
 * and re-solves. If wrapping restores the correct optimum, the bug is confirmed
 * as line-length truncation and the wrap is the fix.
 *
 * Runs the SAME buildLP the production solver uses (fidelity).
 */
import 'dotenv/config';
import type { Cluster, QuestionNode, OutcomeSetRef, MarketRef } from '../../services/arb-solver/src/graph/types.ts';
import { enumerateStates } from '../../services/arb-solver/src/solver/state-enumerator.ts';
import { buildLP } from '../../services/arb-solver/src/solver/lp-builder.ts';
import { NO_EXECUTION_GATE } from '../../services/arb-solver/src/solver/types.ts';
import type { LPProblem } from '../../services/arb-solver/src/solver/types.ts';
import { PriceCache } from '../../services/arb-solver/src/clob/price-cache.ts';

let highs: any = null;
async function getHiGHS() {
  if (!highs) { const mod = await import('highs'); highs = await (mod.default as any)(); }
  return highs;
}

// Production buildLPString (verbatim) but with an optional `wrapEvery`: insert a
// newline + leading space after every `wrapEvery` terms within a line. In free
// LP format a leading-whitespace continuation line is part of the same
// statement, so this is the SAME LP — only the physical line lengths change.
function buildLPString(problem: LPProblem, wrapEvery = 0): string {
  const lines: string[] = ['Minimize'];
  const join = (terms: string[], prefix: string) => {
    if (!wrapEvery) return prefix + terms.join(' + ');
    const out: string[] = [];
    for (let i = 0; i < terms.length; i += wrapEvery) out.push(terms.slice(i, i + wrapEvery).join(' + '));
    return prefix + out.join('\n     + ');
  };
  const objTerms: string[] = [];
  for (let i = 0; i < problem.numVars; i++) if (problem.objective[i] !== 0) objTerms.push(`${problem.objective[i]} x${i}`);
  lines.push(join(objTerms.length ? objTerms : ['0'], '  obj: '));
  lines.push('Subject To');
  for (let s = 0; s < problem.constraints.length; s++) {
    const row = problem.constraints[s];
    const terms: string[] = [];
    for (let i = 0; i < problem.numVars; i++) if (row[i] !== 0) terms.push(`${row[i]} x${i}`);
    if (terms.length > 0) lines.push(join(terms, `  s${s}: `) + ` >= ${problem.rhs[s]}`);
  }
  lines.push('Bounds');
  for (let i = 0; i < problem.numVars; i++) {
    const cap = problem.variables[i]?.maxShares;
    lines.push(cap != null && Number.isFinite(cap) ? `  0 <= x${i} <= ${cap}` : `  x${i} >= 0`);
  }
  lines.push('End');
  return lines.join('\n');
}

let QID = 1, MID = 1, SID = 1;
function makeFatCat(k: number): { cluster: Cluster; price: PriceCache; trueCost: number } {
  QID = 1; MID = 1; SID = 1;
  const price = new PriceCache();
  const questions = new Map<number, QuestionNode>();
  const marketIds = new Set<number>();
  const askSum = 0.85, spreadSum = 0.10;
  const base = askSum / k, spread = spreadSum / k;
  const slotQids: number[] = [];
  for (let i = 0; i < k; i++) {
    const qid = QID++;
    const node: QuestionNode = { questionId: qid, canonicalSubject: `s${qid}`, conditionShape: null, conditionValue: null, conditionDate: null, markets: new Map() };
    questions.set(qid, node); slotQids.push(qid);
    const mid = MID++;
    const ask = Math.min(0.97, Math.max(0.001, base));
    const bid = Math.max(0.0005, ask - spread);
    const ref: MarketRef = { marketId: mid, platform: 'kalshi', platformId: `m${mid}`, endDateMs: null, negRiskEventId: null };
    node.markets.set(mid, ref); marketIds.add(mid);
    price.update({ marketId: mid, platform: 'kalshi', bestBid: bid, bestAsk: ask, bidSize: 200, askSize: 200, timestamp: 1e6 });
  }
  const os: OutcomeSetRef = { setId: SID++, setType: 'categorical', setName: 'c', slotQuestionIds: slotQids, isExhaustive: true };
  const cluster: Cluster = { id: 1, questions, outcomeSets: [os], edges: [], marketIds, validStates: [], dirty: true };
  // true optimum = buy 1 YES of each slot → Σ ask = k·ask
  return { cluster, price, trueCost: k * Math.min(0.97, Math.max(0.001, base)) };
}

async function main() {
  const h = await getHiGHS();
  console.log('k\tlongestLine\ttrueCost\tcost(noWrap)\tstatus\tcost(wrap8)\tstatus\tVERDICT');
  for (const k of [16, 32, 48, 64, 80, 96, 128, 160, 192, 256, 384, 512, 1024]) {
    const { cluster, price, trueCost } = makeFatCat(k);
    cluster.validStates = enumerateStates(cluster, { maxStates: 1e9, clusterSizeCap: 1e9 });
    const lp = buildLP(cluster, price, NO_EXECUTION_GATE)!;

    const sNo = buildLPString(lp, 0);
    const longest = Math.max(...sNo.split('\n').map((l) => l.length));
    let rNo: any, rWr: any;
    try { rNo = h.solve(sNo); } catch (e) { rNo = { Status: 'ABORT:' + (e as Error).message.slice(0, 30) }; }

    const sWr = buildLPString(lp, 8); // wrap every 8 terms
    try { rWr = h.solve(sWr); } catch (e) { rWr = { Status: 'ABORT' }; }

    const cNo = rNo?.ObjectiveValue ?? NaN;
    const cWr = rWr?.ObjectiveValue ?? NaN;
    const okNo = Math.abs(cNo - trueCost) < 0.01;
    const okWr = Math.abs(cWr - trueCost) < 0.01;
    const verdict = okNo ? 'OK' : (okWr ? 'WRAP-FIXES-IT' : 'BOTH-WRONG');
    console.log(`${k}\t${longest}\t${trueCost.toFixed(3)}\t${Number.isFinite(cNo) ? cNo.toFixed(3) : cNo}\t${rNo?.Status}\t${Number.isFinite(cWr) ? cWr.toFixed(3) : cWr}\t${rWr?.Status}\t${verdict}`);
  }
  // Dump a sample of the offending LP for inspection
  const { cluster, price } = makeFatCat(256);
  cluster.validStates = enumerateStates(cluster, { maxStates: 1e9, clusterSizeCap: 1e9 });
  const lp = buildLP(cluster, price, NO_EXECUTION_GATE)!;
  const s = buildLPString(lp, 0).split('\n');
  console.log('\n--- k=256 LP sample ---');
  console.log('Minimize line len:', s[1].length, '| head:', s[1].slice(0, 90), '...');
  console.log('first constraint len:', s[3].length, '| head:', s[3].slice(0, 90), '...');
}

main().catch((e) => { console.error(e); process.exit(1); });
