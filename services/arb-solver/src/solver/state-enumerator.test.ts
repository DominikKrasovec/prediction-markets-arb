/** state-enumerator tests: the budget/overflow guard (freeStates(n) must guard 1<<n against
 *  32-bit overflow and bail before allocating 2^n states) and the bundle/tournament free fall-through. */
import { describe, test, expect, spyOn, afterEach } from 'bun:test';
import { enumerateStates } from './state-enumerator.js';
import { checkOmegaCompleteness, interpretCluster } from './omega-constraints.js';
import type { Cluster, OutcomeSetRef, EdgeRef, QuestionNode, WorldState } from '../graph/types.js';
import type { BasisRisk } from '@arb/types';

/** basisRisk defaults to null so existing no-edge tests stay untouched. */
function edge(
  a: number,
  b: number,
  edgeType: string,
  deterministic = true,
  basisRisk: BasisRisk | null = null,
): EdgeRef {
  return { edgeId: 1, antecedentQuestionId: a, consequentQuestionId: b, edgeType, confidence: 1, deterministic, basisRisk };
}

function makeCluster(qids: number[], outcomeSets: OutcomeSetRef[] = [], edges: EdgeRef[] = []): Cluster {
  const questions = new Map<number, QuestionNode>();
  for (const id of qids) {
    questions.set(id, {
      questionId: id,
      canonicalSubject: `q${id}`,
      conditionShape: null,
      conditionValue: null,
      conditionDate: null,
      markets: new Map(),
    });
  }
  return { id: 1, questions, outcomeSets, edges, marketIds: new Set(), validStates: [], dirty: false };
}

const countTrue = (s: WorldState) => [...s.values()].filter(Boolean).length;

describe('enumerateStates — base cases', () => {
  test('free questions: 2^n states, all assigned', () => {
    const states = enumerateStates(makeCluster([1, 2, 3]));
    expect(states.length).toBe(8); // 2^3
    for (const s of states) {
      expect(s.has(1)).toBe(true);
      expect(s.has(2)).toBe(true);
      expect(s.has(3)).toBe(true);
    }
  });

  test('categorical set (isExhaustive omitted) FAILS SAFE to Σ≤1 (AUD-35)', () => {
    // Fail-safe direction is Σ≤1: an unproven isExhaustive must not read as a risk-free buy-all-YES basket.
    const set: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1, 2, 3] };
    const states = enumerateStates(makeCluster([1, 2, 3], [set]));
    expect(states.length).toBe(4); // 3 one-hot + the all-FALSE world (NOT 3)
    expect(states.filter((s) => countTrue(s) === 1).length).toBe(3);
    expect(states.some((s) => countTrue(s) === 0)).toBe(true); // all-FALSE world present
  });

  test('slot-liveness: Σ=1 set with a slot NOT in the cluster is demoted to Σ≤1', () => {
    // A dangling slot is dropped at the boundary; the survivors no longer provably partition the space.
    const set: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1, 2, 999], isExhaustive: true };
    const states = enumerateStates(makeCluster([1, 2], [set])); // 999 not a cluster question
    expect(states.length).toBe(3); // 2 one-hot + all-FALSE (demoted), NOT 2
    expect(states.some((s) => countTrue(s) === 0)).toBe(true); // dropped slot's world kept
    for (const s of states) expect(s.has(999)).toBe(false); // dangling slot never assigned
  });

  test('slot-liveness: Σ≤1 set with a slot NOT in the cluster just drops the slot (still Σ≤1)', () => {
    const set: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1, 2, 999], isExhaustive: false };
    const states = enumerateStates(makeCluster([1, 2], [set]));
    expect(states.length).toBe(3); // 2 one-hot + all-FALSE, unchanged semantics
    expect(states.some((s) => countTrue(s) === 0)).toBe(true);
  });

  test('categorical set (isExhaustive:true) IS the exhaustive one-hot (Σ=1)', () => {
    // The exhaustive partition is opt-in: a producer must prove it and set isExhaustive=true.
    const set: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1, 2, 3], isExhaustive: true };
    const states = enumerateStates(makeCluster([1, 2, 3], [set]));
    expect(states.length).toBe(3);
    for (const s of states) expect(countTrue(s)).toBe(1);
    expect(states.some((s) => countTrue(s) === 0)).toBe(false); // NO all-FALSE world
  });

  test('categorical NON-exhaustive (Σ≤1): k one-hots PLUS the all-FALSE world', () => {
    // is_exhaustive=false: an unlisted outcome can win, so the all-FALSE world must be enumerated.
    const set: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1, 2, 3], isExhaustive: false };
    const states = enumerateStates(makeCluster([1, 2, 3], [set]));
    expect(states.length).toBe(4); // 3 one-hot + 1 all-FALSE
    expect(states.filter((s) => countTrue(s) === 1).length).toBe(3);
    expect(states.some((s) => countTrue(s) === 0)).toBe(true); // the all-FALSE world
  });

  test('isExhaustive explicitly undefined behaves as FALSE (Σ≤1) — loader NULL path (AUD-35)', () => {
    // An explicit undefined must fail safe to Σ≤1 identical to omitted/false — the loader boundary.
    const set: OutcomeSetRef = {
      setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1, 2, 3],
      isExhaustive: undefined,
    };
    const states = enumerateStates(makeCluster([1, 2, 3], [set]));
    expect(states.length).toBe(4); // 3 one-hot + all-FALSE (Σ≤1)
    expect(states.some((s) => countTrue(s) === 0)).toBe(true);
  });

  test('omitted, undefined, and explicit-false categorical all enumerate identically (Σ≤1)', () => {
    // Pins the equivalence the fail-safe relies on: omitted/undefined/false must be byte-identical.
    const base = { setId: 1, setType: 'categorical' as const, setName: 'c', slotQuestionIds: [1, 2, 3] };
    const omitted = enumerateStates(makeCluster([1, 2, 3], [{ ...base }]));
    const undef = enumerateStates(makeCluster([1, 2, 3], [{ ...base, isExhaustive: undefined }]));
    const explicitFalse = enumerateStates(makeCluster([1, 2, 3], [{ ...base, isExhaustive: false }]));
    expect(omitted.length).toBe(4);
    expect(undef.length).toBe(4);
    expect(explicitFalse.length).toBe(4);
  });

  test('threshold_series: k+1 ordered states', () => {
    const set: OutcomeSetRef = { setId: 1, setType: 'threshold_series', setName: 't', slotQuestionIds: [1, 2, 3] };
    const states = enumerateStates(makeCluster([1, 2, 3], [set]));
    expect(states.length).toBe(4); // k+1
  });

  test('threshold_series IGNORES is_exhaustive (AUD-36): k+1 partition either way, incl. all-FALSE', () => {
    // is_exhaustive is categorical-only; threshold_series always uses its own k+1 partition.
    for (const ex of [true, false, undefined]) {
      const set: OutcomeSetRef = {
        setId: 1, setType: 'threshold_series', setName: 't', slotQuestionIds: [1, 2, 3],
        isExhaustive: ex,
      };
      const states = enumerateStates(makeCluster([1, 2, 3], [set]));
      expect(states.length).toBe(4); // k+1, independent of is_exhaustive
      expect(states.some((s) => countTrue(s) === 0)).toBe(true); // cutoff=0 all-FALSE world
      expect(states.some((s) => countTrue(s) === 3)).toBe(true); // the all-TRUE prefix exists
    }
  });

  test('F-E2E-1 round 2: TWO per-team 3-rung sets enumerate 4×4=16 joint states, not one fused 7-state chain', () => {
    // Two per-team threshold_series ladders cross-product independently: 4×4 = 16 joint worlds.
    const bel = [101, 102, 103]; // 8+, 6+, 4+
    const spa = [201, 202, 203]; // 10+, 8+, 6+
    const belSet: OutcomeSetRef = { setId: 1, setType: 'threshold_series', setName: 'BEL corners', slotQuestionIds: bel };
    const spaSet: OutcomeSetRef = { setId: 2, setType: 'threshold_series', setName: 'ESP corners', slotQuestionIds: spa };
    const two = enumerateStates(makeCluster([...bel, ...spa], [belSet, spaSet]));
    expect(two.length).toBe(16); // 4 × 4 independent ladders

    // A single fused threshold_series over all 6 interleaved rungs has only a 7-state partition.
    const fusedSet: OutcomeSetRef = {
      setId: 1, setType: 'threshold_series', setName: 'fused',
      slotQuestionIds: [201, 101, 202, 102, 203, 103],
    };
    const fused = enumerateStates(makeCluster([...bel, ...spa], [fusedSet]));
    expect(fused.length).toBe(7); // 6+1 fused chain

    // Belgium-high/Spain-low is a legitimate joint outcome present in the 16 but absent
    // from the fused 7 (a total order cannot hold both this world and its mirror).
    const belHighSpaLow = (s: WorldState) =>
      bel.every((q) => s.get(q) === true) && spa.every((q) => s.get(q) === false);
    expect(two.some(belHighSpaLow)).toBe(true);
    expect(fused.some(belHighSpaLow)).toBe(false);
  });

  test('categorical with <2 in-cluster slots → free, NOT a forced one-hot', () => {
    // A 1-slot categorical must not force its lone slot TRUE in every world; it degrades to a free binary.
    const set: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1] };
    const states = enumerateStates(makeCluster([1], [set]));
    expect(states.length).toBe(2); // free: {1=false},{1=true}
    expect(states.some((s) => s.get(1) === false)).toBe(true);
    expect(states.some((s) => s.get(1) === true)).toBe(true);
  });

  test('categorical that drops to 1 in-cluster slot still frees the survivor', () => {
    // Only q1 is in this cluster (q2 lives elsewhere); the lone in-cluster slot must be free.
    const set: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1, 2] };
    const states = enumerateStates(makeCluster([1], [set]));
    expect(states.length).toBe(2);
    expect(states.some((s) => s.get(1) === false)).toBe(true);
  });
});

describe('enumerateStates — budget / overflow guard (the crash fix)', () => {
  test('free questions over MAX_VALID_STATES (2^14 > 10k) → dropped, no crash', () => {
    const qids = Array.from({ length: 14 }, (_, i) => i + 1);
    const states = enumerateStates(makeCluster(qids));
    expect(states.length).toBe(0);
  });

  test('huge free set (n=40) returns [] without overflow/hang', () => {
    const qids = Array.from({ length: 40 }, (_, i) => i + 1);
    const start = Date.now();
    const states = enumerateStates(makeCluster(qids));
    expect(states.length).toBe(0);
    expect(Date.now() - start).toBeLessThan(1000); // must not try to build 2^40
  });

  test('boundary: 13 free questions (2^13 = 8192 ≤ 10k) still enumerates', () => {
    const qids = Array.from({ length: 13 }, (_, i) => i + 1);
    const states = enumerateStates(makeCluster(qids));
    expect(states.length).toBe(8192);
  });
});

describe('enumerateStates — bundle/tournament fall through to free (vanish fix)', () => {
  test('mixed categorical + bundle: bundle slots are present, not dropped', () => {
    const cat: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1, 2], isExhaustive: true };
    const bundle: OutcomeSetRef = { setId: 2, setType: 'bundle', setName: 'b', slotQuestionIds: [3, 4] };
    const states = enumerateStates(makeCluster([1, 2, 3, 4], [cat, bundle]));
    expect(states.length).toBe(8);
    for (const s of states) {
      for (const q of [1, 2, 3, 4]) expect(s.has(q)).toBe(true);
      expect(countTrue(new Map([[1, s.get(1)!], [2, s.get(2)!]]))).toBe(1); // categorical invariant holds
    }
  });

  test('large bundle (intractable as free) → cluster dropped, no crash', () => {
    const bundle: OutcomeSetRef = {
      setId: 1, setType: 'bundle', setName: 'big',
      slotQuestionIds: Array.from({ length: 50 }, (_, i) => i + 1),
    };
    const states = enumerateStates(makeCluster(bundle.slotQuestionIds, [bundle]));
    expect(states.length).toBe(0);
  });
});

describe('edge semantics dispatch', () => {
  // Two free questions = 4 candidate states: {F,F},{T,F},{F,T},{T,T}.
  const hasState = (states: WorldState[], a: boolean, b: boolean) =>
    states.some(s => s.get(1) === a && s.get(2) === b);

  test('mutual_exclusion: only {T,T} is invalid (BLOCKER fix)', () => {
    const states = enumerateStates(makeCluster([1, 2], [], [edge(1, 2, 'mutual_exclusion')]));
    expect(states.length).toBe(3);
    expect(hasState(states, true, true)).toBe(false); // forbidden
    expect(hasState(states, true, false)).toBe(true); // legal under ME (was wrongly pruned before)
    expect(hasState(states, false, true)).toBe(true);
    expect(hasState(states, false, false)).toBe(true);
  });

  test('strict_implication: A=T,B=F is the only invalid state (unchanged)', () => {
    const states = enumerateStates(makeCluster([1, 2], [], [edge(1, 2, 'strict_implication')]));
    expect(states.length).toBe(3);
    expect(hasState(states, true, false)).toBe(false); // forbidden: A⟹B violated
    expect(hasState(states, true, true)).toBe(true);
    expect(hasState(states, false, true)).toBe(true);
    expect(hasState(states, false, false)).toBe(true);
  });

  test('equivalence: only {F,F} and {T,T} survive → 2 states', () => {
    const states = enumerateStates(makeCluster([1, 2], [], [edge(1, 2, 'equivalence')]));
    expect(states.length).toBe(2);
    expect(hasState(states, false, false)).toBe(true);
    expect(hasState(states, true, true)).toBe(true);
    expect(hasState(states, true, false)).toBe(false);
    expect(hasState(states, false, true)).toBe(false);
  });

  test('soft edge types (near_equivalence/probabilistic/conditional) prune nothing', () => {
    for (const t of ['near_equivalence', 'probabilistic', 'conditional']) {
      const states = enumerateStates(makeCluster([1, 2], [], [edge(1, 2, t)]));
      expect(states.length).toBe(4); // soft → no hard pruning even though deterministic=true
    }
  });

  test('non-deterministic strict_implication prunes nothing', () => {
    const states = enumerateStates(
      makeCluster([1, 2], [], [edge(1, 2, 'strict_implication', /* deterministic */ false)]),
    );
    expect(states.length).toBe(4);
  });

  test('non-deterministic mutual_exclusion prunes nothing', () => {
    const states = enumerateStates(
      makeCluster([1, 2], [], [edge(1, 2, 'mutual_exclusion', false)]),
    );
    expect(states.length).toBe(4);
  });

  test('deterministic edge WITH non-none basis_risk STILL hard-prunes (policy lock)', () => {
    // basis_risk is a pricing-haircut concern, NOT a softening reason.
    for (const risk of ['resolution_source', 'date_difference', 'platform_specific'] as const) {
      const states = enumerateStates(
        makeCluster([1, 2], [], [edge(1, 2, 'mutual_exclusion', true, risk)]),
      );
      expect(states.length).toBe(3); // still pruned {T,T}
      expect(hasState(states, true, true)).toBe(false);
    }
  });

  test("unknown edge_type fails open (skips, no pruning)", () => {
    const states = enumerateStates(
      makeCluster([1, 2], [], [edge(1, 2, 'totally_made_up_type')]),
    );
    expect(states.length).toBe(4);
  });

  test('self-edge (antecedent===consequent) is skipped, never forces the question NO', () => {
    // A self mutual_exclusion would otherwise force q1 FALSE in every world; the guard skips it.
    const states = enumerateStates(makeCluster([1, 2], [], [edge(1, 1, 'mutual_exclusion')]));
    expect(states.length).toBe(4);
    expect(hasState(states, true, false)).toBe(true); // q1 TRUE still reachable
    expect(hasState(states, true, true)).toBe(true);
  });

  test('dangling endpoint on an equivalence edge does NOT empty the cluster', () => {
    // Un-guarded, equivalence would prune ALL states for a dangling q3 (silent lost arb);
    // the guard skips it.
    const states = enumerateStates(makeCluster([1, 2], [], [edge(1, 3, 'equivalence')]));
    expect(states.length).toBe(4);
  });

  test('dangling endpoint on strict_implication / mutual_exclusion also skipped', () => {
    for (const t of ['strict_implication', 'mutual_exclusion']) {
      const states = enumerateStates(makeCluster([1, 2], [], [edge(1, 9, t)]));
      expect(states.length).toBe(4); // q9 absent → edge cannot constrain
    }
  });

  test('mutual_exclusion inside a categorical set does not over-prune', () => {
    // An ME edge between two exhaustive-categorical slots is redundant (never both TRUE)
    // and must not prune any legal state.
    const cat: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1, 2, 3], isExhaustive: true };
    const states = enumerateStates(makeCluster([1, 2, 3], [cat], [edge(1, 2, 'mutual_exclusion')]));
    expect(states.length).toBe(3);
    for (const s of states) expect(countTrue(s)).toBe(1);
  });

  test('mutual_exclusion inside a NON-exhaustive categorical: all-FALSE world survives', () => {
    // The ME edge forbids only {T,T} (which a one-hot never produces) and must not
    // prune the all-FALSE world.
    const cat: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1, 2, 3], isExhaustive: false };
    const states = enumerateStates(makeCluster([1, 2, 3], [cat], [edge(1, 2, 'mutual_exclusion')]));
    expect(states.length).toBe(4);
    expect(states.filter((s) => countTrue(s) === 0).length).toBe(1); // all-FALSE preserved
    expect(states.filter((s) => countTrue(s) === 1).length).toBe(3);
  });

  test('multiple hard edges compose (strict_implication chain)', () => {
    const states = enumerateStates(
      makeCluster([1, 2, 3], [], [edge(1, 2, 'strict_implication'), edge(2, 3, 'strict_implication')]),
    );
    expect(states.length).toBe(4);
    for (const s of states) {
      expect(!(s.get(1) === true && s.get(2) === false)).toBe(true);
      expect(!(s.get(2) === true && s.get(3) === false)).toBe(true);
    }
  });
});

describe('enumerateStates — opts wiring + drop diagnostics (observability, no behavior change)', () => {
  // Spy on console.warn (logger routes warn → console.warn). Restore after each.
  let warnSpy: ReturnType<typeof spyOn>;
  const warns = (): string[] =>
    (warnSpy.mock.calls as unknown[][]).map(args => args.map(a => String(a)).join(' '));

  afterEach(() => {
    warnSpy?.mockRestore();
  });

  test('opts.maxStates caps an otherwise-enumerable cluster (config.solver.maxStates now drives it)', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const qids = Array.from({ length: 13 }, (_, i) => i + 1); // 2^13 = 8192
    const dropped = enumerateStates(makeCluster(qids), { maxStates: 100 });
    expect(dropped.length).toBe(0);
    warnSpy.mockRestore();

    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const kept = enumerateStates(makeCluster(qids));
    expect(kept.length).toBe(8192);
  });

  test('drop diagnostic names cluster id, free count, and cause=free-2^n', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const qids = Array.from({ length: 14 }, (_, i) => i + 1); // 2^14 > 10k default
    const states = enumerateStates(makeCluster(qids));
    expect(states.length).toBe(0);
    const joined = warns().join('\n');
    expect(joined).toContain('Cluster 1'); // makeCluster uses id:1
    expect(joined).toContain('free=14');
    expect(joined).toContain('cause=free-2^n');
  });

  test('cartesian blow-up reports cause=cartesian (not free-2^n)', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    // The free set is empty here, so the drop cause must be cartesian, not free-2^n.
    const qids = Array.from({ length: 240 }, (_, i) => i + 1);
    const catA: OutcomeSetRef = {
      setId: 1, setType: 'categorical', setName: 'a',
      slotQuestionIds: qids.slice(0, 120), isExhaustive: true,
    };
    const catB: OutcomeSetRef = {
      setId: 2, setType: 'categorical', setName: 'b',
      slotQuestionIds: qids.slice(120), isExhaustive: true,
    };
    const states = enumerateStates(makeCluster(qids, [catA, catB]));
    expect(states.length).toBe(0);
    const joined = warns().join('\n');
    expect(joined).toContain('DROPPED');
    expect(joined).toContain('cause=cartesian');
    expect(joined).not.toContain('cause=free-2^n');
  });

  test('bundle DROP-PREVIEW fires for a large bundle and names it as the driver', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const bundle: OutcomeSetRef = {
      setId: 7, setType: 'bundle', setName: 'big',
      slotQuestionIds: Array.from({ length: 50 }, (_, i) => i + 1),
    };
    const states = enumerateStates(makeCluster(bundle.slotQuestionIds, [bundle]));
    expect(states.length).toBe(0); // same count as the existing big-bundle test
    const joined = warns().join('\n');
    expect(joined).toContain('DROP-PREVIEW');
    expect(joined).toContain('bundle');
    expect(joined).toContain('treated as free');
  });

  test('small bundle (cat(2)+bundle(2)=8) does NOT false-alarm a DROP-PREVIEW or DROPPED', () => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const cat: OutcomeSetRef = { setId: 1, setType: 'categorical', setName: 'c', slotQuestionIds: [1, 2], isExhaustive: true };
    const bundle: OutcomeSetRef = { setId: 2, setType: 'bundle', setName: 'b', slotQuestionIds: [3, 4] };
    const states = enumerateStates(makeCluster([1, 2, 3, 4], [cat, bundle]));
    expect(states.length).toBe(8); // unchanged from the existing test
    const joined = warns().join('\n');
    expect(joined).not.toContain('DROP-PREVIEW');
    expect(joined).not.toContain('DROPPED');
  });
});

/** A spread family minted exclusive+exhaustive over only its listed rungs drops the gap world;
 *  the completeness check finds the missing polarity and blames the exhaustive set to demote. */
describe('checkOmegaCompleteness (P7)', () => {
  /** rungs {1,2} declared exhaustive, plus a moneyline question 3 both rungs imply. */
  const spreadCluster = (exhaustive: boolean) => {
    const set: OutcomeSetRef = {
      setId: 1, setType: 'categorical', setName: 'spread rungs',
      slotQuestionIds: [1, 2], isExhaustive: exhaustive,
    };
    return makeCluster([1, 2, 3], [set], [
      { ...edge(1, 3, 'strict_implication'), edgeId: 11 },
      { ...edge(2, 3, 'strict_implication'), edgeId: 12 },
    ]);
  };

  test('exhaustive-over-spread-rungs: the merged question is pinned TRUE ⟹ INCOMPLETE, set blamed', () => {
    const c = spreadCluster(true);
    const states = enumerateStates(c);
    // Σ=1 over {1,2} forces q3 TRUE in both worlds — the gap world (both rungs FALSE) is missing.
    expect(states).toHaveLength(2);
    expect(states.every((s) => s.get(3) === true)).toBe(true);

    const check = checkOmegaCompleteness(interpretCluster(c), states);
    expect(check.complete).toBe(false);
    expect(check.incompleteQids).toEqual([3]);
    expect(check.offendingSetIds).toEqual([1]); // blamed via the 1-hop hard edge
  });

  test('demoting the offending set to Σ≤1 ADDS the all-FALSE world and restores completeness', () => {
    const demoted = spreadCluster(false);
    const states = enumerateStates(demoted);
    // (2 one-hot + all-FALSE) × q3 free = 6, minus the 2 the implications prune = 4.
    expect(states).toHaveLength(4);
    expect(states.some((s) => s.get(1) === false && s.get(2) === false && s.get(3) === false)).toBe(true);
    expect(checkOmegaCompleteness(interpretCluster(demoted), states).complete).toBe(true);
  });

  test('mutex-across-rungs: a truncated threshold chain is INCOMPLETE with NO set to demote', () => {
    // No exhaustive categorical exists to demote, so the caller marks the cluster DEGENERATE.
    const chain: OutcomeSetRef = {
      setId: 5, setType: 'threshold_series', setName: 'ladder', slotQuestionIds: [1, 2],
    };
    const c = makeCluster([1, 2], [chain], [{ ...edge(1, 2, 'mutual_exclusion'), edgeId: 21 }]);
    const states = enumerateStates(c);
    expect(states.every((s) => s.get(1) === false)).toBe(true);

    const check = checkOmegaCompleteness(interpretCluster(c), states);
    expect(check.complete).toBe(false);
    expect(check.incompleteQids).toContain(1);
    expect(check.offendingSetIds).toHaveLength(0); // ⟹ degenerate, not repairable
  });

  test('genuine one-hot (k=3, no edges) is COMPLETE — unchanged, nothing demoted', () => {
    const set: OutcomeSetRef = {
      setId: 1, setType: 'categorical', setName: 'negRisk field',
      slotQuestionIds: [1, 2, 3], isExhaustive: true,
    };
    const c = makeCluster([1, 2, 3], [set]);
    const states = enumerateStates(c);
    expect(states).toHaveLength(3);
    const check = checkOmegaCompleteness(interpretCluster(c), states);
    expect(check.complete).toBe(true);
    expect(check.offendingSetIds).toHaveLength(0);
  });

  test('an EMPTY enumeration proves nothing (relaxed/dropped route owns it)', () => {
    const c = makeCluster([1, 2]);
    expect(checkOmegaCompleteness(interpretCluster(c), []).complete).toBe(true);
  });
});
