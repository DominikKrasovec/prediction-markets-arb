/**
 * check-resolved-consistency — READ-ONLY regression checker over RESOLVED markets: checks
 * equivalence edges (A), strict_implication edges (B), mutex edges/sets (C), and exhaustive
 * outcome sets (D, split by set_type: categorical is Σ=1 one-hot; threshold_series is a
 * monotone order-ideal ladder, not one-hot) against platform ground truth. [I] reports
 * intra-question member disagreement separately (informational; poisons A-D otherwise).
 *
 * VOID settlements (PM 50/50, Kalshi VOID) are excluded from A-D — they are split
 * settlements, not refunds, and prove nothing about Ω. Label-vocabulary winners are mapped
 * through `markets.outcomes` order (index 0 = YES-equivalent); non-binary/unknown → UNKNOWN.
 *
 * Usage: npx tsx services/pipeline/src/scripts/check-resolved-consistency.ts [--assert]
 * (--assert exits 1 on any A-D violation, for CI/regression gates; [I] never fails it.)
 */
import { query, endPool } from '@arb/db';

export type MarketVerdict = 'YES' | 'NO' | 'VOID' | 'UNKNOWN';
export type QuestionVerdict = 'YES' | 'NO' | 'VOID' | 'MIXED' | 'UNRESOLVED';

export function marketVerdict(
  winning: string | null | undefined,
  outcomes: unknown,
): MarketVerdict {
  if (winning == null || winning === '') return 'UNKNOWN';
  if (winning === 'VOID_5050' || winning === 'VOID') return 'VOID';
  const w = winning.trim().toLowerCase();
  if (w === 'yes') return 'YES';
  if (w === 'no') return 'NO';
  let labels: string[] | null = null;
  if (Array.isArray(outcomes)) {
    labels = outcomes.map((o) => String(o).trim().toLowerCase());
  } else if (typeof outcomes === 'string') {
    try {
      const parsed = JSON.parse(outcomes);
      if (Array.isArray(parsed)) labels = parsed.map((o) => String(o).trim().toLowerCase());
    } catch { /* not JSON → no vocabulary */ }
  }
  if (!labels || labels.length !== 2) return 'UNKNOWN';
  const idx = labels.indexOf(w);
  if (idx === 0) return 'YES';
  if (idx === 1) return 'NO';
  return 'UNKNOWN';
}

export function aggregateQuestionVerdict(members: MarketVerdict[]): QuestionVerdict {
  let yes = 0, no = 0, voids = 0;
  for (const v of members) {
    if (v === 'YES') yes++;
    else if (v === 'NO') no++;
    else if (v === 'VOID') voids++;
  }
  if (yes > 0 && no > 0) return 'MIXED';
  if (yes > 0) return 'YES';
  if (no > 0) return 'NO';
  if (voids > 0) return 'VOID';
  return 'UNRESOLVED';
}

// `slotVerdicts` must be in slot_ordinal order. threshold_series never imposes Σ=1 (the solver
// builds only the monotone chain z_i ≤ z_{i+1}), so 0..N YES are all sound; only a non-monotone
// pattern (>=2 transitions between YES/NO runs) is a violation.
export function evaluateSet(
  slotVerdicts: ReadonlyArray<QuestionVerdict | null>,
  isExhaustive: boolean,
  setType: string,
): 'multi_yes' | 'zero_yes' | 'ladder_break' | null {
  if (setType === 'threshold_series') {
    let transitions = 0;
    let prev: 'YES' | 'NO' | null = null;
    for (const v of slotVerdicts) {
      if (v !== 'YES' && v !== 'NO') continue;
      if (prev !== null && v !== prev) transitions++;
      prev = v;
    }
    return transitions >= 2 ? 'ladder_break' : null;
  }
  let yes = 0;
  let decisive = 0;
  for (const v of slotVerdicts) {
    if (v === 'YES') { yes++; decisive++; }
    else if (v === 'NO') decisive++;
  }
  if (yes >= 2) return 'multi_yes';
  if (isExhaustive && decisive === slotVerdicts.length && slotVerdicts.length > 0 && yes === 0) {
    return 'zero_yes';
  }
  return null;
}

const ID_CHUNK = 25_000;

function* chunks<T>(arr: readonly T[], n: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n) as T[];
}

interface Violation {
  kind: string;
  detail: string;
}

async function main(): Promise<void> {
  const assertMode = process.argv.includes('--assert');
  const EXAMPLES = 5;

  console.log(`=== resolved-market consistency check — ${new Date().toISOString()} ===`);

  const cov = await query<{
    platform: string; n: number; resolved: number; with_winner: number;
  }>(
    `SELECT platform,
            count(*)::int                 AS n,
            count(resolved_at)::int       AS resolved,
            count(winning_outcome)::int   AS with_winner
       FROM markets GROUP BY 1 ORDER BY 1`,
  );
  console.log('\n-- resolved coverage --');
  let totalResolved = 0;
  for (const r of cov) {
    totalResolved += r.resolved;
    console.log(
      `  ${r.platform.padEnd(11)} markets=${String(r.n).padStart(7)}  ` +
      `resolved=${String(r.resolved).padStart(7)}  winner_known=${String(r.with_winner).padStart(7)}`,
    );
  }

  const members = await query<{
    question_id: number; market_id: number; platform: string;
    winning_outcome: string | null; outcomes: unknown; title: string;
  }>(
    `SELECT qm.question_id, qm.market_id, m.platform, m.winning_outcome, m.outcomes, m.title
       FROM question_members qm
       JOIN markets m ON m.id = qm.market_id
      WHERE m.resolved_at IS NOT NULL`,
  );

  const byQuestion = new Map<number, MarketVerdict[]>();
  let unknownVerdictMembers = 0;
  for (const m of members) {
    const v = marketVerdict(m.winning_outcome, m.outcomes);
    if (v === 'UNKNOWN') unknownVerdictMembers++;
    const list = byQuestion.get(m.question_id);
    if (list) list.push(v); else byQuestion.set(m.question_id, [v]);
  }

  const verdicts = new Map<number, QuestionVerdict>();
  const mixedQuestions: number[] = [];
  for (const [qid, list] of byQuestion) {
    const v = aggregateQuestionVerdict(list);
    verdicts.set(qid, v);
    if (v === 'MIXED') mixedQuestions.push(qid);
  }
  const decidedIds = [...verdicts.entries()]
    .filter(([, v]) => v === 'YES' || v === 'NO')
    .map(([qid]) => qid);
  const decidedSet = new Set(decidedIds);
  const verdictOf = (qid: number): QuestionVerdict | null => verdicts.get(qid) ?? null;

  const totalQ = await query<{ n: number }>(`SELECT count(*)::int AS n FROM questions`);
  console.log(
    `  resolved member rows=${members.length} (verdict UNKNOWN on ${unknownVerdictMembers}); ` +
    `questions with >=1 resolved member: ${byQuestion.size} / ${totalQ[0]?.n ?? 0}; ` +
    `YES/NO-decided questions: ${decidedIds.length}`,
  );

  const violations: Record<'A' | 'B' | 'C' | 'D', Violation[]> = { A: [], B: [], C: [], D: [] };
  let checkableA = 0, checkableB = 0, checkableCEdges = 0, checkableCSets = 0, checkableD = 0;

  // Filter SQL on the antecedent side (chunked) and check the consequent in JS, so chunking
  // can never split a checkable pair.
  if (decidedIds.length > 0) {
    for (const chunk of chunks(decidedIds, ID_CHUNK)) {
      const edges = await query<{
        id: number; edge_type: string; pattern: string | null; a: number; c: number;
      }>(
        `SELECT id, edge_type, pattern,
                antecedent_question_id AS a, consequent_question_id AS c
           FROM implication_edges
          WHERE edge_type IN ('equivalence','strict_implication','mutual_exclusion')
            AND antecedent_question_id = ANY($1::int[])`,
        [chunk],
      );
      for (const e of edges) {
        if (!decidedSet.has(e.c)) continue;
        const va = verdictOf(e.a)!;
        const vc = verdictOf(e.c)!;
        if (e.edge_type === 'equivalence') {
          checkableA++;
          if (va !== vc) {
            violations.A.push({
              kind: `equivalence/${e.pattern ?? 'null'}`,
              detail: `edge#${e.id} q${e.a}=${va} vs q${e.c}=${vc}`,
            });
          }
        } else if (e.edge_type === 'strict_implication') {
          checkableB++;
          if (va === 'YES' && vc === 'NO') {
            violations.B.push({
              kind: `strict_implication/${e.pattern ?? 'null'}`,
              detail: `edge#${e.id} antecedent q${e.a}=YES but consequent q${e.c}=NO`,
            });
          }
        } else {
          checkableCEdges++;
          if (va === 'YES' && vc === 'YES') {
            violations.C.push({
              kind: `mutex_edge/${e.pattern ?? 'null'}`,
              detail: `edge#${e.id} BOTH q${e.a} and q${e.c} resolved YES`,
            });
          }
        }
      }
    }
  }

  if (byQuestion.size > 0) {
    const touchedQids = [...byQuestion.keys()];
    const setIds = new Set<number>();
    for (const chunk of chunks(touchedQids, ID_CHUNK)) {
      const rows = await query<{ set_id: number }>(
        `SELECT DISTINCT set_id FROM outcome_set_slots WHERE question_id = ANY($1::int[])`,
        [chunk],
      );
      for (const r of rows) setIds.add(r.set_id);
    }
    if (setIds.size > 0) {
      const slotRows: Array<{
        set_id: number; question_id: number; slot_ordinal: number; set_type: string;
        is_exhaustive: boolean; set_name: string;
      }> = [];
      for (const chunk of chunks([...setIds], ID_CHUNK)) {
        slotRows.push(...await query<(typeof slotRows)[number]>(
          `SELECT s.set_id, s.question_id, s.slot_ordinal, os.set_type, os.is_exhaustive, os.set_name
             FROM outcome_set_slots s
             JOIN outcome_sets os ON os.id = s.set_id
            WHERE s.set_id = ANY($1::int[])
            ORDER BY s.set_id, s.slot_ordinal`,
          [chunk],
        ));
      }
      const bySet = new Map<number, { meta: (typeof slotRows)[number]; qids: number[]; seen: Set<number> }>();
      for (const r of slotRows) {
        const entry = bySet.get(r.set_id);
        if (entry) { if (!entry.seen.has(r.question_id)) { entry.qids.push(r.question_id); entry.seen.add(r.question_id); } }
        else bySet.set(r.set_id, { meta: r, qids: [r.question_id], seen: new Set([r.question_id]) });
      }
      for (const [setId, { meta, qids }] of bySet) {
        const slotVerdicts = qids.map((q) => verdictOf(q));
        if (!slotVerdicts.some((v) => v === 'YES' || v === 'NO')) continue;
        if (meta.is_exhaustive) checkableD++; else checkableCSets++;
        const result = evaluateSet(slotVerdicts, meta.is_exhaustive, meta.set_type);
        if (result === null) continue;
        const yesQids = qids.filter((q) => verdictOf(q) === 'YES');
        const noQids = qids.filter((q) => verdictOf(q) === 'NO');
        const v: Violation = {
          kind: `${meta.set_type === 'threshold_series' ? 'ladder' : meta.is_exhaustive ? 'sigma1_set' : 'mutex_set'}/${meta.set_type}/${result}`,
          detail: `set#${setId} "${meta.set_name}" slots=${qids.length} ` +
            (result === 'multi_yes'
              ? `YES slots: [${yesQids.join(', ')}]`
              : result === 'ladder_break'
              ? `non-monotone: YES [${yesQids.join(', ')}] interleaved with NO [${noQids.join(', ')}]`
              : `fully resolved with 0 YES`),
        };
        // A threshold_series ladder_break routes to D (the exhaustive-set bucket) alongside
        // categorical Σ=1 breaks, since both live under is_exhaustive=true sets.
        (meta.is_exhaustive ? violations.D : violations.C).push(v);
      }
    }
  }

  const show = (label: string, list: Violation[], checkable: string) => {
    console.log(`  [${label}] ${list.length} violation(s)  (${checkable})`);
    for (const v of list.slice(0, EXAMPLES)) console.log(`      ${v.kind}: ${v.detail}`);
    if (list.length > EXAMPLES) console.log(`      … +${list.length - EXAMPLES} more`);
  };
  console.log('\n-- violations --');
  show('A equivalence disagreement', violations.A, `${checkableA} checkable equivalence edges`);
  show('B implication violated   ', violations.B, `${checkableB} checkable strict_implication edges`);
  show('C mutex >=2 YES          ', violations.C, `${checkableCEdges} checkable mutex edges + ${checkableCSets} mutex sets`);
  show('D sigma=1 set broken     ', violations.D, `${checkableD} checkable exhaustive sets`);
  console.log(`  [I] intra-question disagreement: ${mixedQuestions.length} question(s)` +
    (mixedQuestions.length > 0 ? ` — e.g. q${mixedQuestions.slice(0, EXAMPLES).join(', q')}` : ''));

  const exampleQids = new Set<number>();
  for (const list of Object.values(violations)) {
    for (const v of list.slice(0, EXAMPLES)) {
      for (const m of v.detail.matchAll(/q(\d+)/g)) exampleQids.add(Number(m[1]));
    }
  }
  if (exampleQids.size > 0) {
    const qrows = await query<{ id: number; canonical_subject: string; canonical_event: string | null }>(
      `SELECT id, canonical_subject, canonical_event FROM questions WHERE id = ANY($1::int[])`,
      [[...exampleQids]],
    );
    console.log('\n-- example question subjects --');
    for (const q of qrows) {
      console.log(`  q${q.id}: ${q.canonical_subject}${q.canonical_event ? ` | ${q.canonical_event}` : ''}`);
    }
  }

  const totalViolations =
    violations.A.length + violations.B.length + violations.C.length + violations.D.length;
  if (totalResolved === 0) {
    console.log(
      '\nNOTE: 0 resolved markets in the DB — all checks vacuous. The sync-layer ' +
      'resolution writers fire on the next scrape/sync cycle (the scrape is currently frozen); ' +
      'PM (13k closed payloads) + Predict (214 RESOLVED) are also backfillable from market_metadata_raw.',
    );
  }
  console.log(`\nTOTAL violations: ${totalViolations}${assertMode ? ' (assert mode)' : ''}`);
  if (assertMode && totalViolations > 0) process.exitCode = 1;
}

// Allow `import { marketVerdict } …` from tests without executing the scan.
const entry = process.argv[1] ?? '';
if (entry.endsWith('check-resolved-consistency.ts') || entry.endsWith('check-resolved-consistency.js')) {
  main()
    .catch((err) => {
      console.error('check-resolved-consistency failed:', err);
      process.exitCode = 2;
    })
    .finally(() => endPool());
}
