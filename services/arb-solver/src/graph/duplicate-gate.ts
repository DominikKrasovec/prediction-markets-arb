import type { ConstraintGraph, OutcomeSetRef, QuestionNode, EdgeRef } from './types.js';
import { createLogger } from '@arb/logger';
import { fold, parseCellKey, foldTitleDuplicateHit, winSuffixSlugDuplicateHit, personNameSubsetDuplicateHit, subjectExactValueUndiscriminatedDuplicateHit } from '@arb/types';

const log = createLogger('graph:dup-gate');

export { fold, parseCellKey };

// The duplicate-partition equivalence gate: a categorical (mutex) outcome set
// must not carry two slots that resolve the same real-world cell. Runs
// post-load, per categorical set, pairwise over its slots. On a HIT: Arm C
// (full settlement-signature proof) re-homes twin b onto a and drops b; Arm D
// (partial proof) drops the duplicate slot and demotes the set Σ=1→Σ≤1.
// Conservative: Arm D only removes a wall, Arm C only adds one under full proof.

interface Signature {
  cellKey: string | null;
  dateKey: string | null;
  authorityKey: string;
}

function endDateBucket(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Platform alone is insufficient: for Kalshi the rules template is its
// series (event_ticker prefix before the first '-').
function settlementAuthorityClass(m: {
  platform: string;
  eventTicker?: string | null;
}): string {
  if (m.platform === 'kalshi' && m.eventTicker) {
    const series = m.eventTicker.split('-')[0]?.trim();
    if (series) return `kalshi:${series}`;
  }
  return m.platform;
}

function signatureOf(q: QuestionNode): Signature {
  const cellKey = parseCellKey(q.canonicalSubject);
  // condition_date first, else the end_date bucket only when every member agrees.
  let dateKey: string | null = q.conditionDate ? q.conditionDate.slice(0, 7) : null;
  const authorities = new Set<string>();
  let commonBucket: string | null = null;
  let bucketDisagree = false;
  let sawBucket = false;
  for (const [, m] of q.markets) {
    authorities.add(settlementAuthorityClass(m));
    const b = endDateBucket(m.endDateMs);
    if (b) {
      if (!sawBucket) {
        commonBucket = b;
        sawBucket = true;
      } else if (b !== commonBucket) {
        bucketDisagree = true;
      }
    }
  }
  if (!dateKey) dateKey = bucketDisagree ? null : commonBucket;
  const authorityKey = [...authorities].sort().join('+');
  return { cellKey, dateKey, authorityKey };
}

function foldIdenticalTitles(a: QuestionNode, b: QuestionNode): boolean {
  const at = new Set<string>();
  for (const [, m] of a.markets) {
    const f = fold(m.title);
    if (f) at.add(f);
  }
  const bt = new Set<string>();
  for (const [, m] of b.markets) {
    const f = fold(m.title);
    if (f) bt.add(f);
  }
  const slug = (k: string | null): string => fold((k ?? '').split(':').pop() ?? '') ?? '';
  return foldTitleDuplicateHit(at, bt, fold(a.canonicalSubject ?? '') ?? '', fold(b.canonicalSubject ?? '') ?? '', slug(a.canonicalKey ?? null), slug(b.canonicalKey ?? null));
}

// Proper prefix (len >= 5) of the other's folded subject. Prefix (not
// substring) + length floor keeps namesake false-positives negligible.
function subjectPrefixMatch(a: QuestionNode, b: QuestionNode): boolean {
  const fa = fold(a.canonicalSubject);
  const fb = fold(b.canonicalSubject);
  if (fa.length < 5 || fb.length < 5 || fa === fb) return false;
  const [short, long] = fa.length <= fb.length ? [fa, fb] : [fb, fa];
  if (!long.startsWith(short)) return false;
  if (distinctKbEntities(a, b)) return false;
  return true;
}

function distinctKbEntities(a: QuestionNode, b: QuestionNode): boolean {
  const ea = (a.subjectEntities ?? []).map((s) => fold(s)).filter(Boolean);
  const eb = (b.subjectEntities ?? []).map((s) => fold(s)).filter(Boolean);
  if (ea.length === 0 || eb.length === 0) return false;
  const sa = new Set(ea);
  for (const e of eb) if (sa.has(e)) return false;
  return true;
}

type Arm = 'C' | 'D';
interface Hit {
  aQid: number;
  bQid: number;
  arm: Arm;
  reason: string;
}

export interface DuplicateGateResult {
  duplicateSuspectPairs: Array<[number, number]>;
  hitCount: number;
  collapseCount: number;
  demoteCount: number;
}

// Idempotent-ish: re-homed questions are removed, so a second pass finds nothing new.
export function applyDuplicatePartitionGate(graph: ConstraintGraph): DuplicateGateResult {
  // strict_implication means a nested ladder, not a duplicate; the
  // fold-title arm must not fire on those.
  const equivEdge = new Set<string>();
  const strictImplEdge = new Set<string>();
  for (const e of graph.edges) {
    if (e.deterministic !== true) continue;
    if (e.edgeType === 'equivalence') equivEdge.add(pairKey(e.antecedentQuestionId, e.consequentQuestionId));
    else if (e.edgeType === 'strict_implication') strictImplEdge.add(pairKey(e.antecedentQuestionId, e.consequentQuestionId));
  }
  const setMembership = new Map<number, number>();
  for (const os of graph.outcomeSets) {
    for (const qid of os.slotQuestionIds) setMembership.set(qid, (setMembership.get(qid) ?? 0) + 1);
  }

  const suspectPairs: Array<[number, number]> = [];
  const hits: Hit[] = [];

  for (const os of graph.outcomeSets) {
    if (os.setType !== 'categorical') continue;
    const slots = os.slotQuestionIds;
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const aQid = slots[i];
        const bQid = slots[j];
        const a = graph.questions.get(aQid);
        const b = graph.questions.get(bQid);
        if (!a || !b) continue;
        const hit = classifyPair(a, b, equivEdge, strictImplEdge);
        if (hit) hits.push({ aQid, bQid, ...hit });
      }
    }
  }

  let collapseCount = 0;
  let demoteCount = 0;
  for (const hit of hits) {
    if (!graph.questions.has(hit.aQid) || !graph.questions.has(hit.bQid)) continue;
    if (hit.arm === 'C') {
      collapseAB(graph, hit.aQid, hit.bQid);
      collapseCount++;
      log.info(`§4 Arm C collapse: re-homed Q${hit.bQid} → Q${hit.aQid} (${hit.reason})`);
    } else {
      const demoted = demoteAndDrop(graph, hit.aQid, hit.bQid, setMembership);
      if (demoted) demoteCount++;
      suspectPairs.push([hit.aQid, hit.bQid]);
      log.info(`§4 Arm D demote+refuse: Q${hit.aQid} ~ Q${hit.bQid} (${hit.reason})`);
    }
  }

  if (hits.length > 0) {
    log.warn(
      `Ω-liveness §4 duplicate-partition gate: ${hits.length} HIT(s) — ` +
        `${collapseCount} Arm-C collapse, ${demoteCount} Arm-D set demotion(s), ` +
        `${suspectPairs.length} suspect pair(s) recorded for the trigger belt`,
    );
  }
  // Union with any durable pairs the loader pre-populated, rather than overwrite.
  const seen = new Set<string>();
  const unioned: Array<[number, number]> = [];
  for (const [a, b] of [...(graph.duplicateSuspectPairs ?? []), ...suspectPairs]) {
    const k = pairKey(a, b);
    if (seen.has(k)) continue;
    seen.add(k);
    unioned.push([a, b]);
  }
  graph.duplicateSuspectPairs = unioned;
  return { duplicateSuspectPairs: suspectPairs, hitCount: hits.length, collapseCount, demoteCount };
}

function classifyPair(
  a: QuestionNode,
  b: QuestionNode,
  equivEdge: Set<string>,
  strictImplEdge: Set<string>,
): { arm: Arm; reason: string } | null {
  const sa = signatureOf(a);
  const sb = signatureOf(b);
  const hasEquiv = equivEdge.has(pairKey(a.questionId, b.questionId));

  if (sa.cellKey !== null && sa.cellKey === sb.cellKey) {
    const fullProof =
      sa.dateKey !== null && sa.dateKey === sb.dateKey && sa.authorityKey === sb.authorityKey;
    if (fullProof) return { arm: 'C', reason: `full signature ${sa.cellKey}@${sa.dateKey}/${sa.authorityKey}` };
    return {
      arm: 'D',
      reason: `cellKey ${sa.cellKey} equal; date ${sa.dateKey}≠${sb.dateKey} or authority ${sa.authorityKey}≠${sb.authorityKey}`,
    };
  }

  if (hasEquiv) {
    const fullProof =
      sa.cellKey !== null && sa.cellKey === sb.cellKey && sa.dateKey === sb.dateKey && sa.authorityKey === sb.authorityKey;
    return fullProof
      ? { arm: 'C', reason: 'equivalence edge + full signature' }
      : { arm: 'D', reason: 'equivalence edge between co-slots (signature incomplete)' };
  }

  // cellKey ⊥ on >=1 side, no edge: direct textual/entity evidence only.
  if (sa.cellKey === null || sb.cellKey === null) {
    if (strictImplEdge.has(pairKey(a.questionId, b.questionId))) return null;
    if (foldIdenticalTitles(a, b)) return { arm: 'D', reason: 'fold-identical member titles' };
    if (subjectPrefixMatch(a, b)) return { arm: 'D', reason: 'folded-subject prefix (⊑) match' };
    if (
      subjectExactValueUndiscriminatedDuplicateHit(
        a.canonicalSubject, b.canonicalSubject,
        a.canonicalKey ?? null, b.canonicalKey ?? null,
        a.valuePrimary ?? null, b.valuePrimary ?? null,
        a.valueSecondary ?? null, b.valueSecondary ?? null,
        a.conditionDirection ?? null, b.conditionDirection ?? null,
      ) && !distinctKbEntities(a, b)
    ) {
      return { arm: 'D', reason: 'exact-subject value-undiscriminated duplicate (F10)' };
    }
    if (personNameSubsetDuplicateHit(a.canonicalSubject, b.canonicalSubject) && !distinctKbEntities(a, b)) {
      return { arm: 'D', reason: 'person-name subset fold twin' };
    }
    if (
      winSuffixSlugDuplicateHit(a.canonicalKey ?? null, b.canonicalKey ?? null) &&
      !distinctKbEntities(a, b)
    ) {
      return { arm: 'D', reason: 'win-suffix slug twin' };
    }
  }
  return null;
}

// Arm D: drops the duplicate slot from every set it co-occupies with its
// twin, and demotes exhaustive sets Σ=1→Σ≤1.
function demoteAndDrop(
  graph: ConstraintGraph,
  aQid: number,
  bQid: number,
  setMembership: Map<number, number>,
): boolean {
  const aSets = setMembership.get(aQid) ?? 0;
  const bSets = setMembership.get(bQid) ?? 0;
  let demoted = false;
  for (const os of graph.outcomeSets) {
    if (os.setType !== 'categorical') continue;
    const ia = os.slotQuestionIds.indexOf(aQid);
    const ib = os.slotQuestionIds.indexOf(bQid);
    if (ia < 0 || ib < 0) continue;
    let dropQid: number;
    if (aSets !== bSets) dropQid = aSets <= bSets ? aQid : bQid;
    else dropQid = ia >= ib ? aQid : bQid;
    os.slotQuestionIds = os.slotQuestionIds.filter((q) => q !== dropQid);
    if (os.isExhaustive === true) {
      os.isExhaustive = false;
      demoted = true;
    }
  }
  return demoted;
}

// Arm C: re-homes b onto a, drops b's question + slot, repoints edges b→a.
function collapseAB(graph: ConstraintGraph, aQid: number, bQid: number): void {
  const a = graph.questions.get(aQid);
  const b = graph.questions.get(bQid);
  if (!a || !b) return;
  for (const [mid, m] of b.markets) if (!a.markets.has(mid)) a.markets.set(mid, m);
  graph.questions.delete(bQid);
  for (const os of graph.outcomeSets) {
    if (!os.slotQuestionIds.includes(bQid)) continue;
    const remapped: number[] = [];
    for (const q of os.slotQuestionIds) {
      const nq = q === bQid ? aQid : q;
      if (!remapped.includes(nq)) remapped.push(nq);
    }
    os.slotQuestionIds = remapped;
  }
  const newEdges: EdgeRef[] = [];
  for (const e of graph.edges) {
    const ante = e.antecedentQuestionId === bQid ? aQid : e.antecedentQuestionId;
    const cons = e.consequentQuestionId === bQid ? aQid : e.consequentQuestionId;
    if (ante === cons) continue;
    newEdges.push(ante === e.antecedentQuestionId && cons === e.consequentQuestionId ? e : { ...e, antecedentQuestionId: ante, consequentQuestionId: cons });
  }
  graph.edges = newEdges;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function _signatureOf(q: QuestionNode): Signature {
  return signatureOf(q);
}
