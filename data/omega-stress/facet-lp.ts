/**
 * FACET-LP PROTOTYPE (H-representation arb solver)
 * ================================================
 * Builds the robust-LP / facet form of the arb problem: one LP row per FACET
 * (coherence inequality) instead of one per WORLD. Proves two things against the
 * production V-representation (enumerateStates → buildLP → solveLP):
 *   (1) EQUIVALENCE — identical optimal cost (⟹ identical arb decision) on every
 *       cluster small enough for the V-rep to solve.
 *   (2) FEASIBILITY + SPEED — solves clusters the V-rep DROPS (cartesian /
 *       implication-chain blow-ups past the 10k cap), in O(n) time.
 *
 * Construction (derived in the audit doc): a basket's payoff in world z is
 *   C + Σ_q w_q z_q,  C = Σ_m y⁻_m,  w_q = Σ_{m∈q}(y⁺_m − y⁻_m).
 * "pay ≥ 1 in every world" = min_{z∈Ω} (C + w·z) ≥ 1, and dualizing the inner LP
 * over Ω = {z∈[0,1]ⁿ : Gz ≤ g, Az = a} yields the finite LP below. Exact when Ω
 * is integral (categorical/threshold/order-ideal/single-mutex); conservatively
 * sound otherwise.
 */
import 'dotenv/config';
import type { Cluster, QuestionNode, OutcomeSetRef, EdgeRef, MarketRef } from '../../services/arb-solver/src/graph/types.ts';
import { enumerateStates } from '../../services/arb-solver/src/solver/state-enumerator.ts';
import { buildLP } from '../../services/arb-solver/src/solver/lp-builder.ts';
import { solveLP } from '../../services/arb-solver/src/solver/solver.ts';
import { NO_EXECUTION_GATE } from '../../services/arb-solver/src/solver/types.ts';
import { PriceCache } from '../../services/arb-solver/src/clob/price-cache.ts';

let highs: any = null;
async function getHiGHS() { if (!highs) { const m = await import('highs'); highs = await (m.default as any)(); } return highs; }
const now = () => performance.now();

// ───────────────────────── facet extraction (H-rep) ─────────────────────────
// A facet is a sparse linear (in)equality over question-indicators z_q.
interface Facet { coeff: Map<number, number>; rhs: number; kind: 'le' | 'eq'; } // Σ coeff·z {≤|=} rhs

/** Translate a cluster's typed constraints (outcome sets + edges) into facets. */
function clusterToFacets(cluster: Cluster): Facet[] {
  const facets: Facet[] = [];
  const qset = cluster.questions;
  for (const os of cluster.outcomeSets) {
    const slots = os.slotQuestionIds.filter((q) => qset.has(q));
    if (slots.length < 2) continue;
    if (os.setType === 'categorical') {
      // exhaustive → Σ z = 1 (eq);  non-exhaustive → Σ z ≤ 1 (le)
      const coeff = new Map<number, number>(); slots.forEach((q) => coeff.set(q, 1));
      facets.push({ coeff, rhs: 1, kind: os.isExhaustive ? 'eq' : 'le' });
    } else if (os.setType === 'threshold_series') {
      // thresholdStates makes the TAIL true first (slot i TRUE ⟹ slot i+1 TRUE),
      // i.e. z_i ≤ z_{i+1}.  Facet: z_i − z_{i+1} ≤ 0.
      for (let i = 0; i + 1 < slots.length; i++) {
        facets.push({ coeff: new Map([[slots[i], 1], [slots[i + 1], -1]]), rhs: 0, kind: 'le' });
      }
    }
  }
  for (const e of cluster.edges) {
    if (!qset.has(e.antecedentQid) || !qset.has(e.consequentQid) || e.antecedentQid === e.consequentQid) continue;
    if (e.deterministic !== true) continue;
    if (e.edgeType === 'strict_implication') {
      facets.push({ coeff: new Map([[e.antecedentQid, 1], [e.consequentQid, -1]]), rhs: 0, kind: 'le' }); // z_A ≤ z_B
    } else if (e.edgeType === 'mutual_exclusion') {
      facets.push({ coeff: new Map([[e.antecedentQid, 1], [e.consequentQid, 1]]), rhs: 1, kind: 'le' }); // z_A+z_B ≤ 1
    } else if (e.edgeType === 'equivalence') {
      facets.push({ coeff: new Map([[e.antecedentQid, 1], [e.consequentQid, -1]]), rhs: 0, kind: 'eq' }); // z_A = z_B
    }
  }
  return facets;
}

// ───────────────────────── facet-LP string builder ──────────────────────────
function buildFacetLPString(cluster: Cluster, price: PriceCache): { lp: string; numVars: number; numRows: number; nnz: number } {
  const questions = [...cluster.questions.values()];
  const qIndex = new Map<number, number>(); questions.forEach((q, i) => qIndex.set(q.questionId, i));
  const facets = clusterToFacets(cluster);

  // variable names: yp_<mid>, yn_<mid>, lam_<f>, nu_<f>, mu_<qi>
  const obj: string[] = [];
  // per-market YES/NO objective coeffs (NO ask = 1 − bid, matching production)
  const marketQ = new Map<number, number>(); // mid → questionId
  for (const q of questions) for (const [mid] of q.markets) marketQ.set(mid, q.questionId);
  for (const q of questions) {
    for (const [mid] of q.markets) {
      const s = price.get(mid);
      const askYes = s?.bestAsk ?? 2.0;
      const askNo = s ? 1 - (s.bestBid ?? 0) : 2.0;
      obj.push(`${askYes} yp_${mid}`);
      obj.push(`${askNo} yn_${mid}`);
    }
  }

  // Build the n per-question rows + the coverage row as sparse term lists.
  // Row_q:  Σ_f G[f,q] λ_f + Σ_e A[e,q] ν_e + μ_q + Σ_{m∈q}(yp − yn) ≥ 0
  const rowTerms: string[][] = questions.map(() => []);
  for (const q of questions) {
    const qi = qIndex.get(q.questionId)!;
    rowTerms[qi].push(`+1 mu_${qi}`);
    for (const [mid] of q.markets) { rowTerms[qi].push(`+1 yp_${mid}`); rowTerms[qi].push(`-1 yn_${mid}`); }
  }
  facets.forEach((f, fi) => {
    // dual feasibility row coeff: +G[f,q] for inequality (λ), −A[e,q] for equality (ν).
    const vname = f.kind === 'le' ? `lam_${fi}` : `nu_${fi}`;
    for (const [qid, c0] of f.coeff) {
      const qi = qIndex.get(qid); if (qi === undefined) continue;
      const c = f.kind === 'le' ? c0 : -c0;
      rowTerms[qi].push(`${c >= 0 ? '+' : ''}${c} ${vname}`);
    }
  });

  // Coverage row: −Σ g_f λ_f + Σ a_e ν_e − Σ μ_q + Σ_m yn ≥ 1
  const cov: string[] = [];
  facets.forEach((f, fi) => {
    if (f.kind === 'le') { if (f.rhs !== 0) cov.push(`${-f.rhs >= 0 ? '+' : ''}${-f.rhs} lam_${fi}`); }
    else { if (f.rhs !== 0) cov.push(`${f.rhs >= 0 ? '+' : ''}${f.rhs} nu_${fi}`); }
  });
  questions.forEach((_, qi) => cov.push(`-1 mu_${qi}`));
  for (const q of questions) for (const [mid] of q.markets) cov.push(`+1 yn_${mid}`);

  const lines: string[] = ['Minimize', `  obj: ${obj.join(' + ')}`, 'Subject To'];
  rowTerms.forEach((terms, qi) => { if (terms.length) lines.push(`  rq_${qi}: ${terms.join(' ')} >= 0`); });
  lines.push(`  cover: ${cov.join(' ')} >= 1`);
  // Bounds: y ≥ 0 (default), lam ≥ 0 (default), mu ≥ 0 (default); nu FREE
  lines.push('Bounds');
  facets.forEach((f, fi) => { if (f.kind === 'eq') lines.push(`  nu_${fi} free`); });
  lines.push('End');

  const lp = lines.join('\n');
  const numFacetsLe = facets.filter((f) => f.kind === 'le').length;
  const numFacetsEq = facets.length - numFacetsLe;
  const numVars = 2 * cluster.marketIds.size + numFacetsLe + numFacetsEq + questions.length;
  const nnz = (lp.match(/[yp_|yn_|lam_|nu_|mu_]/g) || []).length; // rough
  return { lp, numVars, numRows: questions.length + 1, nnz };
}

async function solveFacet(cluster: Cluster, price: PriceCache) {
  const { lp, numVars, numRows } = buildFacetLPString(cluster, price);
  const h = await getHiGHS();
  const t = now();
  let res: any;
  try { res = h.solve(lp); } catch (e) { return { status: 'ABORT', cost: NaN, ms: now() - t, numVars, numRows, lpBytes: lp.length }; }
  return { status: res?.Status ?? 'Error', cost: res?.ObjectiveValue ?? NaN, ms: now() - t, numVars, numRows, lpBytes: lp.length };
}

// ───────────────────────── synthetic clusters ───────────────────────────────
let QID = 1, MID = 1, SID = 1;
function mkPrice(): PriceCache { return new PriceCache(); }
function addQ(questions: Map<number, QuestionNode>): QuestionNode {
  const qid = QID++; const n: QuestionNode = { questionId: qid, canonicalSubject: `q${qid}`, conditionShape: null, conditionValue: null, conditionDate: null, markets: new Map() };
  questions.set(qid, n); return n;
}
function addM(q: QuestionNode, price: PriceCache, marketIds: Set<number>, ask: number, spread: number) {
  const mid = MID++; const bid = Math.max(0.0005, Math.min(ask - spread, ask - 1e-6));
  q.markets.set(mid, { marketId: mid, platform: 'kalshi', platformId: `m${mid}`, endDateMs: null, negRiskEventId: null }); marketIds.add(mid);
  price.update({ marketId: mid, platform: 'kalshi', bestBid: bid, bestAsk: Math.min(0.999, ask), bidSize: 200, askSize: 200, timestamp: 1e6 });
}

type Kind = 'categorical' | 'threshold' | 'chain' | 'cartesian' | 'mutexpair';
function makeCluster(kind: Kind, size: number, arb: 'none' | 'arb', seed: number, sets = 2): { cluster: Cluster; price: PriceCache } {
  QID = 1; MID = 1; SID = 1;
  let a = seed >>> 0; const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const questions = new Map<number, QuestionNode>(); const marketIds = new Set<number>(); const outcomeSets: OutcomeSetRef[] = []; const edges: EdgeRef[] = [];
  const price = mkPrice();
  const askSum = arb === 'arb' ? 0.90 : 1.15;

  const oneHot = (k: number, exhaustive: boolean) => {
    const slots: number[] = []; const base = askSum / k;
    for (let i = 0; i < k; i++) { const q = addQ(questions); slots.push(q.questionId); addM(q, price, marketIds, Math.max(0.002, base + (rnd() - 0.5) * base * 0.2), Math.min(0.02, base * 0.3)); }
    outcomeSets.push({ setId: SID++, setType: 'categorical', setName: `c${SID}`, slotQuestionIds: slots, isExhaustive: exhaustive });
  };

  if (kind === 'categorical') oneHot(size, true);
  else if (kind === 'cartesian') for (let s = 0; s < sets; s++) oneHot(size, true);
  else if (kind === 'threshold') {
    // ordered ladder of k rungs as a threshold_series
    const slots: number[] = [];
    for (let i = 0; i < size; i++) { const q = addQ(questions); slots.push(q.questionId); addM(q, price, marketIds, 0.2 + 0.6 * (i / size), 0.01); }
    outcomeSets.push({ setId: SID++, setType: 'threshold_series', setName: 'thr', slotQuestionIds: slots, isExhaustive: false });
  } else if (kind === 'chain') {
    // free questions joined by a strict_implication chain z_1≥z_2≥… (the NCAA/BTC-ladder class)
    const qs: number[] = [];
    for (let i = 0; i < size; i++) { const q = addQ(questions); qs.push(q.questionId); addM(q, price, marketIds, 0.2 + 0.6 * (i / size), 0.01); }
    for (let i = 0; i + 1 < size; i++) edges.push({ edgeId: i + 1, antecedentQid: qs[i], consequentQid: qs[i + 1], edgeType: 'strict_implication', confidence: 1, deterministic: true, basisRisk: null });
  } else if (kind === 'mutexpair') {
    // two questions, mutually exclusive (modeled as one categorical Σ≤1 vs pairwise edge — both)
    const q1 = addQ(questions), q2 = addQ(questions);
    addM(q1, price, marketIds, askSum / 2, 0.01); addM(q2, price, marketIds, askSum / 2, 0.01);
    edges.push({ edgeId: 1, antecedentQid: q1.questionId, consequentQid: q2.questionId, edgeType: 'mutual_exclusion', confidence: 1, deterministic: true, basisRisk: null });
  }
  return { cluster: { id: 1, questions, outcomeSets, edges, marketIds, validStates: [], dirty: true }, price };
}

// V-rep reference (production path)
async function solveVrep(cluster: Cluster, price: PriceCache, cap = 10000) {
  const t0 = now();
  const states = enumerateStates(cluster, { maxStates: cap, clusterSizeCap: 1e9 });
  const tEnum = now() - t0;
  if (states.length === 0) return { dropped: true, cost: NaN, ms: tEnum, states: 0 };
  cluster.validStates = states;
  const lp = buildLP(cluster, price, NO_EXECUTION_GATE)!;
  const r = await solveLP(lp);
  return { dropped: false, cost: r.optimalCost, ms: now() - t0, states: states.length };
}

async function main() {
  await getHiGHS();
  console.log('=== EQUIVALENCE: facet-LP vs production V-rep (cost must match) ===');
  console.log('kind\tsize\tarb\tVrep_states\tVrep_cost\tFacet_cost\tΔ\tVERDICT');
  const cases: [Kind, number, 'none' | 'arb'][] = [
    ['categorical', 4, 'arb'], ['categorical', 4, 'none'], ['categorical', 8, 'arb'],
    ['categorical', 20, 'arb'], ['categorical', 50, 'none'],
    ['threshold', 6, 'none'], ['threshold', 10, 'none'],
    ['chain', 8, 'none'], ['chain', 12, 'none'],
    ['cartesian', 5, 'arb'], ['cartesian', 8, 'none'], ['mutexpair', 2, 'arb'], ['mutexpair', 2, 'none'],
  ];
  let pass = 0;
  for (const [kind, size, arb] of cases) {
    const { cluster, price } = makeCluster(kind, size, arb, 1000 + size);
    const v = await solveVrep(cluster, price);
    const { cluster: c2, price: p2 } = makeCluster(kind, size, arb, 1000 + size); // identical (same seed)
    const f = await solveFacet(c2, p2);
    const d = Math.abs((v.cost ?? NaN) - (f.cost ?? NaN));
    const ok = v.dropped ? false : d < 1e-4;
    if (ok) pass++;
    console.log(`${kind}\t${size}\t${arb}\t${v.dropped ? 'DROP' : v.states}\t${Number.isFinite(v.cost) ? v.cost.toFixed(4) : 'NA'}\t${Number.isFinite(f.cost) ? f.cost.toFixed(4) : f.status}\t${Number.isFinite(d) ? d.toExponential(1) : 'NA'}\t${ok ? 'MATCH ✓' : 'DIFF ✗'}`);
  }
  console.log(`\nEQUIVALENCE: ${pass}/${cases.length} match`);

  console.log('\n=== FEASIBILITY + SPEED: clusters the V-rep DROPS ===');
  console.log('kind\tsize\ttrue|Ω|\tVrep\t\tFacet_status\tFacet_rows\tFacet_ms');
  for (const [kind, size] of [['chain', 50], ['chain', 188], ['chain', 335], ['cartesian', 100], ['cartesian', 200], ['categorical', 5000]] as [Kind, number][]) {
    const { cluster, price } = makeCluster(kind, size, 'none', 7);
    const v = await solveVrep(cluster, price);
    const { cluster: c2, price: p2 } = makeCluster(kind, size, 'none', 7);
    const f = await solveFacet(c2, p2);
    const trueOmega = kind === 'chain' ? `${size + 1}` : kind === 'cartesian' ? `~(${size}+1)^2` : `${size}`;
    console.log(`${kind}\t${size}\t${trueOmega}\t${v.dropped ? 'DROPPED' : v.cost.toFixed(3) + '(' + v.states + 'st)'}\t${f.status}\t\t${f.numRows}\t\t${f.ms.toFixed(2)}`);
  }

  console.log('\n=== SPEEDUP: facet vs V-rep where both solve (categorical) ===');
  console.log('k\tVrep_ms\tVrep_cost\tFacet_ms\tFacet_cost\tspeedup');
  for (const k of [64, 256, 512, 1024]) {
    const { cluster, price } = makeCluster('categorical', k, 'arb', 3);
    const v = await solveVrep(cluster, price, 1e9);
    const { cluster: c2, price: p2 } = makeCluster('categorical', k, 'arb', 3);
    // warm + median of 3
    await solveFacet(c2, p2);
    const fs: number[] = []; let fc = NaN; for (let i = 0; i < 3; i++) { const r = await solveFacet(c2, p2); fs.push(r.ms); fc = r.cost; }
    const fm = fs.sort((a, b) => a - b)[1];
    console.log(`${k}\t${v.ms.toFixed(1)}\t${Number.isFinite(v.cost) ? v.cost.toFixed(3) : 'NA'}\t${fm.toFixed(2)}\t${Number.isFinite(fc) ? fc.toFixed(3) : 'NA'}\t${(v.ms / fm).toFixed(0)}x`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
