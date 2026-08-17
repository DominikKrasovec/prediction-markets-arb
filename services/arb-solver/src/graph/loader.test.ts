/**
 * Unit tests for the loader-side liveness filters. Pure: no DB.
 *  - filterEdgesToLiveEndpoints
 *  - filterOutcomeSetSlotsToLive: dangling outcome-set slots must be dropped
 *    like dangling edges, and a Σ=1 set that lost a member must be demoted to
 *    Σ≤1, never kept exhaustive over the survivors.
 */
import { describe, test, expect, spyOn, afterEach, mock } from 'bun:test';
import { filterEdgesToLiveEndpoints, filterOutcomeSetSlotsToLive } from './loader.js';
import { buildClusters } from './cluster-builder.js';
import type { TxOptions } from '@arb/db';
import type { QuestionNode, EdgeRef, OutcomeSetRef, ConstraintGraph } from './types.js';

const q = (id: number): QuestionNode => ({
  questionId: id,
  canonicalSubject: `subject-${id}`,
  conditionShape: null,
  conditionValue: null,
  conditionDate: null,
  markets: new Map(),
});

const e = (id: number, a: number, c: number): EdgeRef => ({
  edgeId: id,
  antecedentQuestionId: a,
  consequentQuestionId: c,
  edgeType: 'strict_implication',
  confidence: 1.0,
  deterministic: true,
  basisRisk: null,
});

describe('filterEdgesToLiveEndpoints', () => {
  const questions = new Map<number, QuestionNode>([[1, q(1)], [2, q(2)], [3, q(3)]]);

  test('keeps both-live edges', () => {
    expect(filterEdgesToLiveEndpoints([e(10, 1, 2), e(11, 2, 3)], questions))
      .toHaveLength(2);
  });

  test('drops a synthetic dangling edge (one dead endpoint — the 499-class bridge vector)', () => {
    const kept = filterEdgesToLiveEndpoints([e(10, 1, 999), e(11, 999, 2), e(12, 1, 3)], questions);
    expect(kept.map((x) => x.edgeId)).toEqual([12]);
  });

  test('drops both-dead edges (the inert expired-fixture mass)', () => {
    expect(filterEdgesToLiveEndpoints([e(10, 998, 999)], questions)).toHaveLength(0);
  });

  test('strictly conservative: output is always a subset of input, never reordered', () => {
    const input = [e(1, 1, 2), e(2, 1, 999), e(3, 3, 2)];
    const out = filterEdgesToLiveEndpoints(input, questions);
    expect(out.every((x) => input.includes(x))).toBe(true);
    expect(out.map((x) => x.edgeId)).toEqual([1, 3]);
  });

  test('empty questions map drops everything (no bridging through an empty graph)', () => {
    expect(filterEdgesToLiveEndpoints([e(1, 1, 2)], new Map())).toHaveLength(0);
  });
});

const os = (
  setId: number,
  slotQuestionIds: number[],
  isExhaustive?: boolean,
): OutcomeSetRef => ({
  setId,
  setType: 'categorical',
  setName: `set-${setId}`,
  slotQuestionIds,
  ...(isExhaustive !== undefined ? { isExhaustive } : {}),
});

describe('filterOutcomeSetSlotsToLive (dangling outcome-set slots)', () => {
  const questions = new Map<number, QuestionNode>([[1, q(1)], [2, q(2)], [3, q(3)]]);
  let warnSpy: ReturnType<typeof spyOn> | undefined;
  const warnLines = (): string =>
    ((warnSpy?.mock.calls ?? []) as unknown[][])
      .map((args) => args.map((a) => String(a)).join(' '))
      .join('\n');

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
  });

  test('dangling slot in a Σ=1 set → slot dropped, set DEMOTED to Σ≤1, warn logged', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const out = filterOutcomeSetSlotsToLive([os(10, [1, 2, 999], true)], questions);
    expect(out).toHaveLength(1);
    expect(out[0].slotQuestionIds).toEqual([1, 2]); // dangling 999 dropped, order kept
    // The DEMOTION is the soundness core: Σ=1 over the survivors would delete the
    // world where q999's outcome happens — the fake buy-all-YES direction.
    expect(out[0].isExhaustive).toBe(false);
    expect(warnLines()).toContain('DEMOTED 1');
    expect(warnLines()).toContain('dropped 1 dangling slot');
  });

  test('dangling slot in a Σ≤1 set → slot dropped, flag untouched, no demotion counted', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const out = filterOutcomeSetSlotsToLive([os(11, [1, 999, 3], false)], questions);
    expect(out).toHaveLength(1);
    expect(out[0].slotQuestionIds).toEqual([1, 3]);
    expect(out[0].isExhaustive).toBe(false);
    expect(warnLines()).toContain('DEMOTED 0');
  });

  test('undefined isExhaustive with a dangling slot stays undefined (downstream fail-safe owns it)', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const out = filterOutcomeSetSlotsToLive([os(12, [1, 999])], questions);
    expect(out).toHaveLength(1);
    expect(out[0].slotQuestionIds).toEqual([1]);
    expect(out[0].isExhaustive).toBeUndefined(); // coerced downstream to Σ≤1 anyway
  });

  test('no dangling slots → sets pass through UNCHANGED (same references, Σ=1 preserved)', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const input = [os(13, [1, 2, 3], true), os(14, [2, 3], false)];
    const out = filterOutcomeSetSlotsToLive(input, questions);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(input[0]); // identity — zero-diff on clean data
    expect(out[1]).toBe(input[1]);
    expect(out[0].isExhaustive).toBe(true); // a fully-live provable partition KEEPS Σ=1
    expect(warnLines()).toBe(''); // no warn on the clean path
  });

  test('ALL slots dangling → the set is removed entirely', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const out = filterOutcomeSetSlotsToLive([os(15, [998, 999], true)], questions);
    expect(out).toHaveLength(0);
    expect(warnLines()).toContain('removed 1 fully-dangling');
  });

  test('Appendix-A boot regression: filtered graph survives buildClusters (no crash)', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    // The Appendix-A scenario: an outcome set referencing a question the liveness
    // gate dropped. Pre-6c999fc this crashed buildClusters (`adj.get(slot[j])!` on
    // undefined). The loader filter now removes the dangling slot before the graph
    // is built; buildClusters' own adj.has guard stays as defense-in-depth.
    const sets = filterOutcomeSetSlotsToLive([os(16, [1, 2, 999], true)], questions);
    const graph: ConstraintGraph = { questions, outcomeSets: sets, edges: [] };
    const clusters = buildClusters(graph); // must not throw
    expect(clusters.length).toBeGreaterThan(0);
    const withSet = clusters.find((c) => c.outcomeSets.length > 0);
    expect(withSet?.outcomeSets[0].isExhaustive).toBe(false); // demoted set reached the cluster
  });
});

describe('loadConstraintGraph snapshot isolation', () => {
  test('reads all tables inside ONE BEGIN ISOLATION LEVEL REPEATABLE READ snapshot', async () => {
    // Stage-4 finalize rewrites questions/question_members/outcome_sets/
    // outcome_set_slots/implication_edges non-atomically, so a loader that
    // reads them with per-query autocommit could mix epochs mid-finalize.
    // The loader must issue all its SELECTs on ONE client inside a single
    // REPEATABLE READ transaction.
    //
    // Seam: replace @arb/db's withTx with a faithful fake — it constructs the BEGIN
    // via the REAL buildBeginCommand (spread from the actual module) applied to the
    // loader's options, records every statement, and hands the same recording client
    // to the callback (as the real withTx does). Every loader read returns 0 rows,
    // yielding an empty-but-valid graph; the boot self-checks (columnExists/
    // tableExists) fail SAFE on 0 rows.
    const actual = await import('@arb/db'); // real module, captured before mocking
    const executed: string[] = [];
    const clientsSeen = new Set<unknown>();
    let capturedOpts: TxOptions | undefined;

    const fakeClient = {
      query(text: string) {
        executed.push(text);
        clientsSeen.add(this);
        return Promise.resolve({ rows: [] });
      },
    };

    await mock.module('@arb/db', () => ({
      ...actual,
      async withTx(
        fn: (c: typeof fakeClient) => Promise<unknown>,
        opts: TxOptions = {},
      ) {
        capturedOpts = opts;
        await fakeClient.query(actual.buildBeginCommand(opts)); // real BEGIN string
        const result = await fn(fakeClient);
        await fakeClient.query('COMMIT');
        return result;
      },
    }));

    // Dynamic import AFTER the mock so the loader binds the fake withTx.
    const { loadConstraintGraph } = await import('./loader.js');
    const graph = await loadConstraintGraph();

    // Intent: the loader asked for a single-snapshot, read-only transaction.
    expect(capturedOpts).toMatchObject({ isolationLevel: 'REPEATABLE READ', readOnly: true });

    // The literal command issued to the DB, first statement of the transaction.
    expect(executed[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(executed[0]).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ');

    // Every read rode the SAME single client → one MVCC snapshot, no epoch mixing.
    expect(clientsSeen.size).toBe(1);

    // Sanity: the loader actually ran its core SELECTs inside the snapshot.
    expect(executed.some((s) => /FROM questions\b/.test(s))).toBe(true);
    expect(executed.some((s) => /FROM implication_edges\b/.test(s))).toBe(true);
    expect(executed.some((s) => /FROM outcome_sets\b/.test(s))).toBe(true);
    expect(executed[executed.length - 1]).toBe('COMMIT');

    // 0 rows everywhere → structurally empty but valid graph (no throw).
    expect(graph.questions.size).toBe(0);
    expect(graph.edges).toHaveLength(0);
    expect(graph.outcomeSets).toHaveLength(0);

    mock.restore();
  });
});
