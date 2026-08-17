// Duplicate-partition gate — pipeline-side twin of the arb-solver's runtime belt
// (graph/duplicate-gate.ts): prevents two categorical slots that resolve the same
// real-world partition cell from coexisting as a mutex wall (a fake double-NO). Arm C
// (full signature proof) collapses the twin question into the kept one; Arm D (partial
// hit) drops the duplicate slot, demotes the set Σ=1→Σ≤1, and records the pair for the
// solver belt. Conservative: D only removes a wall, C only adds one under full proof.
import type pg from 'pg';
import { withTx } from '@arb/db';
import { createLogger } from '@arb/logger';
// Cell parser + fold live in @arb/types/cell-key so this gate and the solver belt never drift.
import { fold, parseCellKey, foldTitleDuplicateHit, winSuffixSlugDuplicateHit, personNameSubsetDuplicateHit, subjectExactValueUndiscriminatedDuplicateHit } from '@arb/types';

const log = createLogger('stage4-dup-gate');

export { fold, parseCellKey };

function endDateBucket(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  const ms = d instanceof Date ? d.getTime() : new Date(d).getTime();
  if (!Number.isFinite(ms)) return null;
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Settlement-authority "rules family" — Kalshi series prefix, else platform. */
function settlementAuthorityClass(m: { platform: string; eventTicker: string | null }): string {
  if (m.platform === 'kalshi' && m.eventTicker) {
    const series = m.eventTicker.split('-')[0]?.trim();
    if (series) return `kalshi:${series}`;
  }
  return m.platform;
}

export interface MemberFact {
  platform: string;
  endDate: Date | string | null;
  title: string | null;
  eventTicker: string | null;
}

/** Everything the gate needs about one slot question. */
export interface SlotFacts {
  questionId: number;
  canonicalSubject: string | null;
  canonicalKey?: string | null;
  conditionDate: string | null;
  participants: string[];
  members: MemberFact[];
  // pg returns NUMERIC as a string; NULL = unknown/absent axis.
  valuePrimary?: number | string | null;
  valueSecondary?: number | string | null;
  conditionDirection?: string | null;
}

interface Signature {
  cellKey: string | null;
  dateKey: string | null;
  authorityKey: string;
}

function signatureOf(q: SlotFacts): Signature {
  const cellKey = parseCellKey(q.canonicalSubject);
  // condition_date first; else the common member end_date bucket iff all members agree.
  let dateKey: string | null = q.conditionDate ? q.conditionDate.slice(0, 7) : null;
  const authorities = new Set<string>();
  let commonBucket: string | null = null;
  let bucketDisagree = false;
  let sawBucket = false;
  for (const m of q.members) {
    authorities.add(settlementAuthorityClass(m));
    const b = endDateBucket(m.endDate);
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

function foldIdenticalTitles(a: SlotFacts, b: SlotFacts): boolean {
  // Title-fold alone over-hits Kalshi categorical siblings (shared title, outcome in
  // yes_sub_title), so the predicate also requires the folded subjects not to be distinct.
  const at = new Set<string>();
  for (const m of a.members) {
    const f = fold(m.title);
    if (f) at.add(f);
  }
  const bt = new Set<string>();
  for (const m of b.members) {
    const f = fold(m.title);
    if (f) bt.add(f);
  }
  const slug = (k: string | null): string => fold((k ?? '').split(':').pop() ?? '') ?? '';
  return foldTitleDuplicateHit(at, bt, fold(a.canonicalSubject ?? '') ?? '', fold(b.canonicalSubject ?? '') ?? '', slug(a.canonicalKey ?? null), slug(b.canonicalKey ?? null));
}

/** Distinct KB entities (disjoint non-empty participant sets). */
function distinctKbEntities(a: SlotFacts, b: SlotFacts): boolean {
  const ea = a.participants.map((s) => fold(s)).filter(Boolean);
  const eb = b.participants.map((s) => fold(s)).filter(Boolean);
  if (ea.length === 0 || eb.length === 0) return false;
  const sa = new Set(ea);
  for (const e of eb) if (sa.has(e)) return false;
  return true;
}

function subjectPrefixMatch(a: SlotFacts, b: SlotFacts): boolean {
  const fa = fold(a.canonicalSubject);
  const fb = fold(b.canonicalSubject);
  if (fa.length < 5 || fb.length < 5 || fa === fb) return false;
  const [short, long] = fa.length <= fb.length ? [fa, fb] : [fb, fa];
  if (!long.startsWith(short)) return false;
  if (distinctKbEntities(a, b)) return false; // distinct-entity veto
  return true;
}

export type Arm = 'C' | 'D';
export interface PairVerdict {
  arm: Arm;
  reason: string;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

// Classification for a co-slot pair, or null for no-hit. Byte-faithful to the solver belt's classifyPair.
export function classifyPair(
  a: SlotFacts,
  b: SlotFacts,
  equivEdge: Set<string>,
  strictImplEdge: Set<string>,
): PairVerdict | null {
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

  if (sa.cellKey === null || sb.cellKey === null) {
    // A strict_implication edge is a nested ladder, not a duplicate — never fold-dedup it.
    if (strictImplEdge.has(pairKey(a.questionId, b.questionId))) return null;
    if (foldIdenticalTitles(a, b)) return { arm: 'D', reason: 'fold-identical member titles' };
    if (subjectPrefixMatch(a, b)) return { arm: 'D', reason: 'folded-subject prefix (⊑) match' };
    // Exact-equal folded subjects (cellKey ⊥ on both sides): hit only when the value
    // tuple is non-discriminating (releases score grids) AND the outcome slug matches
    // exactly (a differing slug is a real discriminator). Same distinct-KB veto as ⊑.
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
    // Person/entity-name subset twin (surname ⊂ full name); same distinct-KB veto.
    if (personNameSubsetDuplicateHit(a.canonicalSubject, b.canonicalSubject) && !distinctKbEntities(a, b)) {
      return { arm: 'D', reason: 'person-name subset fold twin' };
    }
    // Win-suffix slug twin: a drifting LLM outcome slug split across two mutex slots.
    if (
      winSuffixSlugDuplicateHit(a.canonicalKey ?? null, b.canonicalKey ?? null) &&
      !distinctKbEntities(a, b)
    ) {
      return { arm: 'D', reason: 'win-suffix slug twin' };
    }
  }
  return null;
}

interface SetSlotRow {
  set_id: number;
  is_exhaustive: boolean;
  slot_ordinal: number;
  question_id: number;
  canonical_subject: string | null;
  canonical_key: string | null;
  condition_date: string | null;
  participants: string[] | null;
  // pg returns NUMERIC as string.
  value_primary: string | null;
  value_secondary: string | null;
  condition_direction: string | null;
}
interface MemberRow {
  question_id: number;
  platform: string;
  end_date: Date | string | null;
  title: string | null;
  event_ticker: string | null;
}
interface EdgeRow {
  a: number;
  b: number;
  edge_type: string;
}

export interface DuplicateGateStage4Result {
  hitCount: number;
  collapseCount: number;
  demoteCount: number;
  suspectPairs: number;
}

// Idempotent-ish: a re-home removes the twin question, so a second pass finds nothing new.
export async function runDuplicatePartitionGateStage4(): Promise<DuplicateGateStage4Result> {
  return withTx((client) => runDuplicatePartitionGateOnClient(client));
}

export interface DuplicateGateOpts {
  /** Restrict the pass to these outcome_set ids. Omit = all categorical sets. */
  onlySetIds?: number[];
}

// Parameterized on a single pg client; runDuplicatePartitionGateStage4 wraps this in withTx.
export async function runDuplicatePartitionGateOnClient(
  client: pg.PoolClient,
  opts: DuplicateGateOpts = {},
): Promise<DuplicateGateStage4Result> {
  const onlySetIds = opts.onlySetIds ?? null;
  const setRows = (await client.query<SetSlotRow>(
    `SELECT os.id AS set_id, os.is_exhaustive, s.slot_ordinal, s.question_id,
            q.canonical_subject, q.canonical_key, q.condition_date, q.participants,
            q.value_primary, q.value_secondary, q.condition_direction
     FROM outcome_sets os
     JOIN outcome_set_slots s ON s.set_id = os.id
     JOIN questions q ON q.id = s.question_id
     WHERE os.set_type = 'categorical'
       AND q.archived_at IS NULL
       AND ($1::int[] IS NULL OR os.id = ANY($1::int[]))
     ORDER BY os.id, s.slot_ordinal`,
    [onlySetIds],
  )).rows;
  if (setRows.length === 0) return { hitCount: 0, collapseCount: 0, demoteCount: 0, suspectPairs: 0 };

  const qids = [...new Set(setRows.map((r) => r.question_id))];
  const memberRows = (await client.query<MemberRow>(
    `SELECT qm.question_id, m.platform, m.end_date, m.title,
            mr.raw->>'event_ticker' AS event_ticker
     FROM question_members qm
     JOIN markets m ON m.id = qm.market_id
     LEFT JOIN market_metadata_raw mr ON mr.market_id = m.id
     WHERE qm.question_id = ANY($1::int[])`,
    [qids],
  )).rows;
  const edgeRows = (await client.query<EdgeRow>(
    `SELECT antecedent_question_id AS a, consequent_question_id AS b, edge_type
     FROM implication_edges
     WHERE deterministic = TRUE
       AND edge_type IN ('equivalence','strict_implication')
       AND archived_at IS NULL
       AND antecedent_question_id = ANY($1::int[])
       AND consequent_question_id = ANY($1::int[])`,
    [qids],
  )).rows;

  const membersByQ = new Map<number, MemberFact[]>();
  for (const m of memberRows) {
    let arr = membersByQ.get(m.question_id);
    if (!arr) { arr = []; membersByQ.set(m.question_id, arr); }
    arr.push({ platform: m.platform, endDate: m.end_date, title: m.title, eventTicker: m.event_ticker });
  }
  const factsByQ = new Map<number, SlotFacts>();
  for (const r of setRows) {
    if (factsByQ.has(r.question_id)) continue;
    factsByQ.set(r.question_id, {
      questionId: r.question_id,
      canonicalSubject: r.canonical_subject,
      canonicalKey: r.canonical_key,
      conditionDate: r.condition_date,
      participants: Array.isArray(r.participants) ? r.participants : [],
      members: membersByQ.get(r.question_id) ?? [],
      valuePrimary: r.value_primary,
      valueSecondary: r.value_secondary,
      conditionDirection: r.condition_direction,
    });
  }
  const equivEdge = new Set<string>();
  const strictImplEdge = new Set<string>();
  for (const e of edgeRows) {
    if (e.edge_type === 'equivalence') equivEdge.add(pairKey(e.a, e.b));
    else strictImplEdge.add(pairKey(e.a, e.b));
  }

  const slotsBySet = new Map<number, Array<{ qid: number; ordinal: number }>>();
  const setMembership = new Map<number, number>();
  for (const r of setRows) {
    let arr = slotsBySet.get(r.set_id);
    if (!arr) { arr = []; slotsBySet.set(r.set_id, arr); }
    arr.push({ qid: r.question_id, ordinal: r.slot_ordinal });
    setMembership.set(r.question_id, (setMembership.get(r.question_id) ?? 0) + 1);
  }

  interface Hit { setId: number; aQid: number; bQid: number; aOrd: number; bOrd: number; arm: Arm; reason: string; }
  const hits: Hit[] = [];
  for (const [setId, slots] of slotsBySet) {
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const a = factsByQ.get(slots[i].qid);
        const b = factsByQ.get(slots[j].qid);
        if (!a || !b) continue;
        const v = classifyPair(a, b, equivEdge, strictImplEdge);
        if (v) hits.push({ setId, aQid: slots[i].qid, bQid: slots[j].qid, aOrd: slots[i].ordinal, bOrd: slots[j].ordinal, ...v });
      }
    }
  }
  if (hits.length === 0) return { hitCount: 0, collapseCount: 0, demoteCount: 0, suspectPairs: 0 };

  let collapseCount = 0;
  let demoteCount = 0;
  const suspectPairs: Array<{ setId: number; a: number; b: number; reason: string }> = [];
  const homedAway = new Set<number>(); // questions removed by a prior Arm-C collapse

  {
    for (const hit of hits) {
      if (homedAway.has(hit.aQid) || homedAway.has(hit.bQid)) continue; // stale after a collapse
      if (hit.arm === 'C') {
        // Re-home the twin (bQid) onto aQid, drop its slots everywhere, archive it.
        await client.query(
          `UPDATE question_members qm SET question_id = $1
           WHERE qm.question_id = $2
             AND NOT EXISTS (SELECT 1 FROM question_members k WHERE k.question_id = $1 AND k.market_id = qm.market_id)`,
          [hit.aQid, hit.bQid],
        );
        await client.query(`DELETE FROM question_members WHERE question_id = $1`, [hit.bQid]);
        await client.query(`DELETE FROM outcome_set_slots WHERE question_id = $1`, [hit.bQid]);
        await client.query(`UPDATE questions SET archived_at = NOW() WHERE id = $1`, [hit.bQid]);
        homedAway.add(hit.bQid);
        collapseCount++;
        log.info(`§4 Arm C collapse: re-homed Q${hit.bQid} → Q${hit.aQid} (${hit.reason})`);
      } else {
        // Drop the duplicate slot from the question in FEWER sets (tie → higher ordinal).
        const aSets = setMembership.get(hit.aQid) ?? 0;
        const bSets = setMembership.get(hit.bQid) ?? 0;
        let dropQid: number;
        if (aSets !== bSets) dropQid = aSets <= bSets ? hit.aQid : hit.bQid;
        else dropQid = hit.aOrd >= hit.bOrd ? hit.aQid : hit.bQid;
        await client.query(`DELETE FROM outcome_set_slots WHERE set_id = $1 AND question_id = $2`, [hit.setId, dropQid]);
        await client.query(
          `UPDATE outcome_sets
           SET is_exhaustive = FALSE,
               slot_count = (SELECT COUNT(*)::int FROM outcome_set_slots s WHERE s.set_id = $1),
               updated_at = NOW()
           WHERE id = $1`,
          [hit.setId],
        );
        const lo = Math.min(hit.aQid, hit.bQid);
        const hi = Math.max(hit.aQid, hit.bQid);
        await client.query(
          `INSERT INTO outcome_set_duplicate_suspects (set_id, question_a_id, question_b_id, reason)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (set_id, question_a_id, question_b_id) DO UPDATE SET reason = EXCLUDED.reason, detected_at = NOW()`,
          [hit.setId, lo, hi, hit.reason],
        );
        demoteCount++;
        suspectPairs.push({ setId: hit.setId, a: lo, b: hi, reason: hit.reason });
        log.info(`§4 Arm D demote+refuse: set ${hit.setId} Q${hit.aQid} ~ Q${hit.bQid} (${hit.reason})`);
      }
    }
  }

  log.warn(
    `Ω-liveness §4 duplicate-partition gate (durable): ${hits.length} HIT(s) — ` +
      `${collapseCount} Arm-C collapse, ${demoteCount} Arm-D demotion(s), ` +
      `${suspectPairs.length} suspect pair(s) recorded`,
  );
  return { hitCount: hits.length, collapseCount, demoteCount, suspectPairs: suspectPairs.length };
}
