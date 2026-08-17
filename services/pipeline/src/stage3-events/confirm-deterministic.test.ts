/**
 * Pure-helper tests for the deterministic confirmer (§17). The DB-driven
 * confirm/persist path is covered by the guards (guards.test.ts) + integration;
 * here we lock the option classifier (substring-safety) and the numeric ladder
 * ordinal direction (a wrong direction = inverted implication edges = fake arb).
 */
import { describe, test, expect } from 'bun:test';
import {
  classifyOption, isPropLabel, setsEqual, thresholdOrdinals, slugifyOutcome,
  childSubjectSet, tryRejectDisjointSubjects, tryNumeric, buildDeterministicMatchContext,
  e1RejectTag, e1KeysShare, u1Admit, nativeIndependentRefusal,
  type EventMeta, type ChildRow,
} from './confirm-deterministic.js';
import { validateMatch, type EventMatchResult, type MatchContext } from './guards.js';

describe('classifyOption', () => {
  test('draw / tie synonyms → DRAW (a real exclusive outcome)', () => {
    for (const l of ['Draw', 'draw', 'Tie', 'tie/co-winners', 'No Contest', 'Draw (Arsenal vs. Chelsea)']) {
      expect(classifyOption(l)).toBe('DRAW');
    }
  });
  test('catch-all → RESIDUAL', () => {
    for (const l of ['Other', 'Field', 'The Field', 'Another party', 'Any other candidate', 'None of the above']) {
      expect(classifyOption(l)).toBe('RESIDUAL');
    }
  });
  test('real entities containing draw/field/tie/other as a SUBSTRING → null (not misclassified)', () => {
    // These are the measured substring hazards from the spec §17b.
    for (const l of ['Motherwell', 'Fairfield', 'Baker Mayfield', 'Liaoning Tieren FC', 'Otherton United']) {
      expect(classifyOption(l)).toBeNull();
    }
  });
});

describe('isPropLabel (bundle detector → defer to LLM)', () => {
  test('prop/score labels → true', () => {
    for (const l of ['Exact Score: 0-0', 'Over 2.5', 'Under 220.5', 'Both Teams to Score', 'Handicap +1', 'Anytime Goalscorer', '2-1']) {
      expect(isPropLabel(l)).toBe(true);
    }
  });
  test('threshold / dollar / spread labels → true (2026-06-02: 3,124 markets that escaped before)', () => {
    for (const l of ['Above 250K', 'Above 0.4%', 'Below 100', '$100M', '$1B', 'Price to Beat: $12,882', '23+ pts', '750+', '(-2.5)', '350 or above', '40 or more']) {
      expect(isPropLabel(l)).toBe(true);
    }
  });
  test('real team/person names → false (incl. names with digits)', () => {
    for (const l of ['Arsenal', 'Schalke 04', 'Manchester United', 'São Paulo FC', 'Brooklyn Nets', 'Kevin Durant', '1. FC Köln', 'CD Numancia', 'Lokomotiv 1929']) {
      expect(isPropLabel(l)).toBe(false);
    }
  });
});

describe('setsEqual', () => {
  test('equal / unequal', () => {
    expect(setsEqual(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(setsEqual(new Set(['a', 'b']), new Set(['a', 'b', 'c']))).toBe(false);
    expect(setsEqual(new Set(['a']), new Set(['b']))).toBe(false);
  });
});

describe('thresholdOrdinals (ordinal 1 = strictest, for the ladder edge direction)', () => {
  test('above (≥X): strictest = highest value → ordinal 1', () => {
    const o = thresholdOrdinals([90000, 100000, 80000], 'above');
    expect(o.get(100000)).toBe(1); // hardest to clear = strictest
    expect(o.get(90000)).toBe(2);
    expect(o.get(80000)).toBe(3); // easiest
  });
  test('below (≤X): strictest = lowest value → ordinal 1', () => {
    const o = thresholdOrdinals([5, 1, 3], 'below');
    expect(o.get(1)).toBe(1);
    expect(o.get(3)).toBe(2);
    expect(o.get(5)).toBe(3);
  });
});

describe('slugifyOutcome', () => {
  test('canonicalizes to a stable id', () => {
    expect(slugifyOutcome('Brooklyn Nets')).toBe('brooklyn_nets');
    expect(slugifyOutcome('DRAW')).toBe('draw');
    expect(slugifyOutcome('São Paulo FC')).toBe('s_o_paulo_fc');
  });
});

// AUD-20: deterministic disjoint-subject reject
function ev(over: Partial<EventMeta> = {}): EventMeta {
  return {
    id: 1, platform: 'kalshi', title: 'T', grouping_type: 'categorical_exclusive',
    canonical_subject: null, category: 'politics', sport: null, league: null,
    event_kind: 'election_outcome_winner', native_independent: false, ...over,
  };
}
function child(over: Partial<ChildRow> = {}): ChildRow {
  return {
    pe_id: 1, market_id: Math.floor(Math.random() * 1e9), platform: 'kalshi', label: null,
    resolution_scope: null, sport: null, value_primary: null, value_secondary: null, value_unit: null,
    direction: null, shape: null, condition_metric: null, canonical_subject: null,
    event_kind: null, metric_scope: null,
    canonical_event: null, condition_date: null, condition_date_precision: null,
    strike_type: null, weather_text: null, settlement_dimension: null, title: null, discriminators: null,
    platform_id: null, pm_condition_ids: null, kalshi_series: null,
    native_outcomes: null, ...over,
  };
}

describe('childSubjectSet', () => {
  test('lowercases + drops null/blank', () => {
    const set = childSubjectSet([
      child({ canonical_subject: 'Donald Trump' }),
      child({ canonical_subject: 'kamala harris' }),
      child({ canonical_subject: null }),
      child({ canonical_subject: '   ' }),
    ]);
    expect([...set].sort()).toEqual(['donald trump', 'kamala harris']);
  });
});

describe('tryRejectDisjointSubjects (AUD-20)', () => {
  test('non-exempt (election vs election) fully disjoint => REJECT', () => {
    const a = ev({ id: 1, event_kind: 'election_outcome_winner' });
    const b = ev({ id: 2, event_kind: 'election_outcome_winner' });
    const ca = [child({ canonical_subject: 'Donald Trump' }), child({ canonical_subject: 'JD Vance' })];
    const cb = [child({ canonical_subject: 'Gavin Newsom' }), child({ canonical_subject: 'Josh Shapiro' })];
    expect(tryRejectDisjointSubjects(a, ca, b, cb)).toBe(true);
  });

  test('exempt kind on EITHER side => NOT rejected', () => {
    const ca = [child({ canonical_subject: 'Anaheim Ducks' })];
    const cb = [child({ canonical_subject: 'Vegas Golden Knights' })];
    expect(tryRejectDisjointSubjects(
      ev({ id: 1, event_kind: 'match_total_metric' }), ca,
      ev({ id: 2, event_kind: 'match_winner' }), cb,
    )).toBe(false);
    expect(tryRejectDisjointSubjects(
      ev({ id: 1, event_kind: 'match_winner' }), ca,
      ev({ id: 2, event_kind: 'election_outcome_winner' }), cb,
    )).toBe(false);
    expect(tryRejectDisjointSubjects(
      ev({ id: 1, event_kind: 'price_threshold' }), ca,
      ev({ id: 2, event_kind: 'player_prop_threshold' }), cb,
    )).toBe(false);
    expect(tryRejectDisjointSubjects(
      ev({ id: 1, event_kind: 'crypto_launch_fdv' }), ca,
      ev({ id: 2, event_kind: 'crypto_launch_fdv' }), cb,
    )).toBe(false);
  });

  test('one side NULL event_kind => NOT rejected (defer to LLM)', () => {
    const ca = [child({ canonical_subject: 'Donald Trump' })];
    const cb = [child({ canonical_subject: 'Gavin Newsom' })];
    expect(tryRejectDisjointSubjects(
      ev({ id: 1, event_kind: null }), ca,
      ev({ id: 2, event_kind: 'election_outcome_winner' }), cb,
    )).toBe(false);
    expect(tryRejectDisjointSubjects(
      ev({ id: 1, event_kind: 'election_outcome_winner' }), ca,
      ev({ id: 2, event_kind: null }), cb,
    )).toBe(false);
  });

  test('sharing >=1 subject => NOT rejected (not disjoint)', () => {
    const a = ev({ id: 1, event_kind: 'election_outcome_winner' });
    const b = ev({ id: 2, event_kind: 'election_outcome_winner' });
    const ca = [child({ canonical_subject: 'Donald Trump' }), child({ canonical_subject: 'JD Vance' })];
    const cb = [child({ canonical_subject: 'donald trump' }), child({ canonical_subject: 'Josh Shapiro' })];
    expect(tryRejectDisjointSubjects(a, ca, b, cb)).toBe(false);
  });

  test('a side with NO known subjects => NOT rejected (cannot prove disjoint)', () => {
    const a = ev({ id: 1, event_kind: 'election_outcome_winner' });
    const b = ev({ id: 2, event_kind: 'election_outcome_winner' });
    const ca = [child({ canonical_subject: 'Donald Trump' })];
    const cb = [child({ canonical_subject: null }), child({ canonical_subject: '  ' })];
    expect(tryRejectDisjointSubjects(a, ca, b, cb)).toBe(false);
  });
});

// Native-independence refusal. tryCategorical / tryU1 must not stamp
// categorical_exclusive when either event is natively independent
// (grouping_type='bundle_nonexclusive' OR Kalshi mutually_exclusive='false', folded
// into EventMeta.native_independent). The refusal short-circuits before the KB option
// build, so the predicate is the load-bearing unit under test here.
describe('nativeIndependentRefusal (F4)', () => {
  test('EITHER side native_independent => REFUSE (the buy-NO-across fake)', () => {
    // Kalshi acquisitions bundle: platform says mutually_exclusive='false' → refuse.
    expect(nativeIndependentRefusal(
      ev({ id: 1, native_independent: true }),
      ev({ id: 2, native_independent: false }),
    )).toBe(true);
    // Mirror side (bundle_nonexclusive on the other event) → refuse.
    expect(nativeIndependentRefusal(
      ev({ id: 1, native_independent: false }),
      ev({ id: 2, native_independent: true, grouping_type: 'bundle_nonexclusive' }),
    )).toBe(true);
    // Both independent → refuse.
    expect(nativeIndependentRefusal(
      ev({ id: 1, native_independent: true }),
      ev({ id: 2, native_independent: true }),
    )).toBe(true);
  });

  test('NEITHER side native_independent => NOT refused (positive signal only)', () => {
    // A genuine contested-target Σ=1 (both natively mutually_exclusive='true' → the
    // field is false) mints as before. NULL/absent metadata already folds to false.
    expect(nativeIndependentRefusal(
      ev({ id: 1, native_independent: false }),
      ev({ id: 2, native_independent: false }),
    )).toBe(false);
  });
});

// E1: same-kind KB-disjoint reject (pure predicate — the KB neutralizer itself is
// validated by the s3b-p0-replay.ts zero-flip). e1RejectTag takes ALREADY-resolved
// key sets, so these tests lock the kind-gate + disjoint logic only.
describe('e1RejectTag (E1 same-kind disjoint)', () => {
  const A = new Set(['solstice']);
  const B = new Set(['hylo']);

  test('same E1 kind + disjoint KB keys => REJECT with per-kind tag', () => {
    for (const k of ['crypto_launch_fdv', 'weather_extreme', 'policy_action']) {
      const tag = e1RejectTag(k, k, A, B);
      expect(tag).not.toBeNull();
      expect(tag).toContain(k);
    }
  });

  test('shared KB key (alias drift already folded) => NO reject', () => {
    expect(e1RejectTag('crypto_launch_fdv', 'crypto_launch_fdv',
      new Set(['aligned']), new Set(['aligned', 'other']))).toBeNull();
  });

  test('SAME-TOKEN prefix drift => NO reject (the 2 rebuild-#237 misses)', () => {
    // Stage-1 truncation stamps the SAME launch under folded keys where one is a
    // prefix of the other. E1 must NOT fire (recall loss avoided, monotone-safe).
    expect(e1RejectTag('crypto_launch_fdv', 'crypto_launch_fdv',
      new Set(['alignedlayer']), new Set(['aligned']))).toBeNull();
    expect(e1RejectTag('crypto_launch_fdv', 'crypto_launch_fdv',
      new Set(['felix']), new Set(['felixprotocol']))).toBeNull();
  });

  test('genuinely different tokens (no prefix relation) => REJECT', () => {
    expect(e1RejectTag('crypto_launch_fdv', 'crypto_launch_fdv',
      new Set(['solstice']), new Set(['hylo']))).not.toBeNull();
  });

  test('kind NOT in E1 set => never fires (AUD-20 owns those / defer)', () => {
    expect(e1RejectTag('token_launch', 'token_launch', A, B)).toBeNull();
    expect(e1RejectTag('election_outcome_winner', 'election_outcome_winner', A, B)).toBeNull();
  });

  test('different kinds => never fires (E1 is same-kind only)', () => {
    expect(e1RejectTag('crypto_launch_fdv', 'weather_extreme', A, B)).toBeNull();
  });

  test('NULL kind or an empty key set => defer (cannot prove disjoint)', () => {
    expect(e1RejectTag(null, 'crypto_launch_fdv', A, B)).toBeNull();
    expect(e1RejectTag('crypto_launch_fdv', 'crypto_launch_fdv', new Set(), B)).toBeNull();
    expect(e1RejectTag('crypto_launch_fdv', 'crypto_launch_fdv', A, new Set())).toBeNull();
  });
});

describe('e1KeysShare (prefix neutralizer)', () => {
  test('equal / prefix (short ≥4) => share', () => {
    expect(e1KeysShare(new Set(['aligned']), new Set(['aligned']))).toBe(true);
    expect(e1KeysShare(new Set(['alignedlayer']), new Set(['aligned']))).toBe(true);
    expect(e1KeysShare(new Set(['felix']), new Set(['felixprotocol']))).toBe(true);
  });
  test('disjoint tokens => no share', () => {
    expect(e1KeysShare(new Set(['solstice']), new Set(['hylo', 'tempo']))).toBe(false);
  });
  test('short (<4) common stem must NOT trigger a prefix share', () => {
    // "sun" is a prefix of both but only 3 chars → not a share (avoids noise stems).
    expect(e1KeysShare(new Set(['sun']), new Set(['sunday']))).toBe(false);
  });
});

// AUD-21: numeric confirmer fires on CHILD subjects (event-level was dead)
describe('tryNumeric child-subject gating (AUD-21)', () => {
  function ladderChildren(subject: string, vals: number[], dir: 'above' | 'below', plat: string): ChildRow[] {
    return vals.map((v) => child({
      platform: plat, canonical_subject: subject, value_primary: v, value_unit: 'usd',
      direction: dir, shape: 'monotonic_threshold', event_kind: 'price_threshold',
    }));
  }

  test('fires when each side resolves to ONE matching child subject (event subject NULL)', async () => {
    const a: EventMeta = ev({ id: 1, platform: 'kalshi', canonical_subject: null, category: 'crypto' });
    const b: EventMeta = ev({ id: 2, platform: 'polymarket', canonical_subject: null, category: 'crypto' });
    const ca = ladderChildren('bitcoin', [90000, 100000], 'above', 'kalshi');
    const cb = ladderChildren('bitcoin', [90000, 100000], 'above', 'polymarket');
    const r = await tryNumeric(a, ca, b, cb);
    expect(r).not.toBeNull();
    expect(r!.grouping_kind).toBe('threshold_series');
    expect(r!.canonical_subject).toBe('bitcoin');
    expect(r!.outcome_set!.length).toBe(2);
  });

  test('drift-tolerant: alias prefix subjects collapse to one and still fire', async () => {
    const a: EventMeta = ev({ id: 1, platform: 'kalshi', canonical_subject: null, category: 'crypto' });
    const b: EventMeta = ev({ id: 2, platform: 'polymarket', canonical_subject: null, category: 'crypto' });
    const ca = ladderChildren('kraken', [10, 20], 'above', 'kalshi');
    const cb = ladderChildren('kraken ipo closing market cap', [10, 20], 'above', 'polymarket');
    const r = await tryNumeric(a, ca, b, cb);
    expect(r).not.toBeNull();
  });

  test('DEFERS (null) when the two sides are DIFFERENT subjects => no cross-subject fuse', async () => {
    const a: EventMeta = ev({ id: 1, platform: 'kalshi', canonical_subject: null, category: 'crypto' });
    const b: EventMeta = ev({ id: 2, platform: 'polymarket', canonical_subject: null, category: 'crypto' });
    const ca = ladderChildren('o1', [10, 20], 'above', 'kalshi');
    const cb = ladderChildren('probable', [10, 20], 'above', 'polymarket');
    expect(await tryNumeric(a, ca, b, cb)).toBeNull();
  });

  test('DEFERS when one side mixes two distinct child subjects', async () => {
    const a: EventMeta = ev({ id: 1, platform: 'kalshi', canonical_subject: null, category: 'crypto' });
    const b: EventMeta = ev({ id: 2, platform: 'polymarket', canonical_subject: null, category: 'crypto' });
    const ca = [
      ...ladderChildren('o1', [10], 'above', 'kalshi'),
      ...ladderChildren('probable', [20], 'above', 'kalshi'),
    ];
    const cb = ladderChildren('o1', [10, 20], 'above', 'polymarket');
    expect(await tryNumeric(a, ca, b, cb)).toBeNull();
  });

  test('DEFERS when a side has NO known child subject (cannot prove identity)', async () => {
    const a: EventMeta = ev({ id: 1, platform: 'kalshi', canonical_subject: null, category: 'crypto' });
    const b: EventMeta = ev({ id: 2, platform: 'polymarket', canonical_subject: null, category: 'crypto' });
    const ca = ladderChildren('bitcoin', [90000, 100000], 'above', 'kalshi').map((c) => ({ ...c, canonical_subject: null }));
    const cb = ladderChildren('bitcoin', [90000, 100000], 'above', 'polymarket');
    expect(await tryNumeric(a, ca, b, cb)).toBeNull();
  });
});

// ── c52a25a parity: the DETERMINISTIC path must arm the same guards as the LLM
// path. The 8 live CA-XX advance×place-first one-hot merges (SEs 846/847/852/
// 867/876/899/919/920) were minted by THIS confirmer (llm_model=
// 'deterministic-options') while the guard's inputs (marketTitle /
// priorLegs[].title) flowed only through llm-event-match — so the guard was
// inert exactly where it mattered and the fakes re-minted on every rebuild.
describe('buildDeterministicMatchContext (guard-input parity with the LLM path)', () => {
  // The CA-45 re-mint shape: PM "advance" binaries (UNNORMALIZED — NULL
  // event_kind, that NULL is the bridge) × Kalshi "place first" children
  // (event_kind=election_outcome_winner), same candidate label set → the
  // option-set confirmer proposes a per-candidate one-hot merge.
  const pmAdvance = (mid: number, cand: string): ChildRow => child({
    pe_id: 10, market_id: mid, platform: 'polymarket', label: cand,
    title: `Will ${cand} advance from the CA-45 primary election?`,
    event_kind: null,
  });
  const kalshiPlaceFirst = (mid: number, cand: string): ChildRow => child({
    pe_id: 20, market_id: mid, platform: 'kalshi', label: cand,
    title: `Will ${cand} place first in the 2026 CA-45 primary?`,
    event_kind: 'election_outcome_winner',
  });
  const childrenA = [pmAdvance(1, 'Amy Phan West'), pmAdvance(3, 'Derek Tran')];
  const childrenB = [kalshiPlaceFirst(2, 'Amy Phan West'), kalshiPlaceFirst(4, 'Derek Tran')];
  // Exactly the proposal shape tryCategorical emits for equal option sets.
  const proposal = (): EventMatchResult => ({
    same_event: true,
    confidence: 1.0,
    reasoning: 'deterministic option-set match: 2 shared canonical options',
    canonical_event: '2026 CA-45 primary',
    canonical_subject: null,
    grouping_kind: 'categorical_exclusive',
    participants: ['Amy Phan West', 'Derek Tran'],
    outcome_set: [
      { outcome_id: 'amy_phan_west', label: 'Amy Phan West', outcome_subject: 'Amy Phan West', is_residual: false },
      { outcome_id: 'derek_tran', label: 'Derek Tran', outcome_subject: 'Derek Tran', is_residual: false },
    ],
    leg_mapping: [
      { outcome_id: 'amy_phan_west', platform: 'polymarket', market_id: 1 },
      { outcome_id: 'amy_phan_west', platform: 'kalshi', market_id: 2 },
      { outcome_id: 'derek_tran', platform: 'polymarket', market_id: 3 },
      { outcome_id: 'derek_tran', platform: 'kalshi', market_id: 4 },
    ],
  });

  test('CA-45 re-mint scenario: the advance×place-first guard now FIRES on the deterministic path', () => {
    const ctx = buildDeterministicMatchContext(proposal(), childrenA, childrenB, undefined, undefined);
    const v = validateMatch(proposal(), ctx);
    expect(v.kind).toBe('reject');
    if (v.kind === 'reject') expect(v.reason).toContain('advance/place-first');
  });

  test('sound election merge (place-first × place-first) still passes with titles supplied', () => {
    const cleanA = [
      child({ pe_id: 10, market_id: 1, platform: 'polymarket', label: 'Amy Phan West', title: 'Will Amy Phan West win the CA-45 primary?', event_kind: 'election_outcome_winner' }),
      child({ pe_id: 10, market_id: 3, platform: 'polymarket', label: 'Derek Tran', title: 'Will Derek Tran win the CA-45 primary?', event_kind: 'election_outcome_winner' }),
    ];
    const ctx = buildDeterministicMatchContext(proposal(), cleanA, childrenB, undefined, undefined);
    const v = validateMatch(proposal(), ctx);
    expect(v.kind).toBe('match');
  });

  test('expansion re-mint: a persisted prior ADVANCE leg blocks a new place-first leg (priorLegs.title threaded)', () => {
    // SE already holds the PM advance leg; the deterministic expansion pair now
    // brings the Kalshi place-first counterpart onto the same outcome_id.
    const priorLegs = [{
      outcome_id: 'amy_phan_west', outcome_subject: 'Amy Phan West', market_id: 1,
      canonical_subject: 'Amy Phan West', event_kind: null, metric_scope: null,
      market_canonical_event: null, condition_date: null, condition_date_precision: null,
      title: 'Will Amy Phan West advance from the CA-45 primary election?', kalshi_series: null,
      platform: 'polymarket', platform_event_id: 10,
    }];
    const p: EventMatchResult = {
      ...proposal(),
      leg_mapping: [
        { outcome_id: 'amy_phan_west', platform: 'kalshi', market_id: 2 },
        { outcome_id: 'derek_tran', platform: 'kalshi', market_id: 4 },
      ],
    };
    const ctx = buildDeterministicMatchContext(p, [], childrenB, undefined, priorLegs);
    expect(ctx.priorLegs?.[0]?.title).toBe('Will Amy Phan West advance from the CA-45 primary election?');
    const v = validateMatch(p, ctx);
    // the amy place-first leg is dropped against the prior advance leg; kalshi
    // survives via derek's leg → match with a drop warning (subtractive guard).
    expect(v.kind).toBe('match');
    if (v.kind === 'match') expect(v.warnings.some((w) => w.includes('advance/place-first'))).toBe(true);
    expect(p.leg_mapping!.map((l) => l.market_id)).toEqual([4]);
  });

  test('FIELD PARITY: every MatchContext input validateMatch consumes is supplied (documented exceptions only)', () => {
    const ctx = buildDeterministicMatchContext(proposal(), childrenA, childrenB, new Map(), []);
    // Fields the LLM path (llm-event-match.ts) supplies. Deliberate, verified-safe
    // absences on the deterministic path:
    //  - marketNativeLabel: the deterministic confirmer keys outcomes BY native
    //    label (buildOptions), so a FIX-④ positional mis-map cannot occur.
    //  - marketDates[].end_date: consumed only by P3 §3 (deadline_window_iso
    //    verification); deterministic proposals never set deadline_window_iso.
    const required: (keyof MatchContext)[] = [
      'minConfidence', 'marketPlatform', 'marketScope', 'subjectType',
      'marketSubject', 'marketEventKind', 'marketNumeric', 'marketWeather',
      'marketDates', 'marketCanonicalEvent', 'marketTitle',
      'marketDiscriminators', 'marketPlatformEvent',
      'priorLegSubjects', 'priorLegEventKinds', 'priorLegs',
      'reconcileMetricScope', 'newCanonicalEvent', 'reconcileEnabled',
    ];
    for (const f of required) {
      expect(ctx[f] === undefined ? `MISSING:${String(f)}` : `ok:${String(f)}`).toBe(`ok:${String(f)}`);
    }
    // per-market maps must cover EVERY child of both sides
    for (const c of [...childrenA, ...childrenB]) {
      expect(ctx.marketTitle!.get(c.market_id)).toBe(c.title);
      expect(ctx.marketPlatform.get(c.market_id)).toBe(c.platform);
      expect(ctx.marketEventKind!.get(c.market_id)).toBe(c.event_kind);
    }
    // priorLegs sub-fields: title must be threaded (the second drifted field)
    const pl = buildDeterministicMatchContext(proposal(), childrenA, childrenB, undefined, [{
      outcome_id: 'x', outcome_subject: null, market_id: 9, canonical_subject: null,
      event_kind: 'primary_winner', metric_scope: 'm', market_canonical_event: 'ce',
      condition_date: '2026-06-02', condition_date_precision: 'day', title: 't9', kalshi_series: null,
      platform: 'kalshi', platform_event_id: 77,
    }]).priorLegs![0];
    expect(pl.title).toBe('t9');
    expect(pl.metric_scope).toBe('m');
    expect(pl.event_kind).toBe('primary_winner');
    expect(pl.market_canonical_event).toBe('ce');
    expect(pl.condition_date).toBe('2026-06-02');
    // P0 same-platform sibling guard fields threaded
    expect(pl.platform).toBe('kalshi');
    expect(pl.platform_event_id).toBe(77);
    // marketPlatformEvent covers every child (via ChildRow.pe_id)
    for (const c of [...childrenA, ...childrenB]) {
      expect(ctx.marketPlatformEvent!.get(c.market_id)).toBe(c.pe_id);
    }
  });
});

describe('u1Admit (Predict↔PM condition-id bridge admission — pure)', () => {
  const pm = ev({ id: 1, platform: 'polymarket' });
  const pred = ev({ id: 2, platform: 'predict' });
  const pmChild = (mid: number, cid: string) => child({ market_id: mid, platform: 'polymarket', platform_id: cid, label: 'Team A' });
  const predChild = (mid: number, cids: string[]) => child({ market_id: mid, platform: 'predict', platform_id: String(mid), pm_condition_ids: cids });

  test('intersecting condition id ⇒ admits with PM/Predict oriented', () => {
    const r = u1Admit(pm, [pmChild(10, '0xabc')], pred, [predChild(20, ['0xabc'])]);
    expect(r).not.toBeNull();
    expect(r!.pmEv.platform).toBe('polymarket');
    expect(r!.predEv.platform).toBe('predict');
  });
  test('orientation-independent (predict as A)', () => {
    const r = u1Admit(pred, [predChild(20, ['0xabc'])], pm, [pmChild(10, '0xabc')]);
    expect(r).not.toBeNull();
    expect(r!.pmEv.platform).toBe('polymarket');
  });
  test('no condition-id overlap ⇒ null', () => {
    expect(u1Admit(pm, [pmChild(10, '0xabc')], pred, [predChild(20, ['0xZZZ'])])).toBeNull();
  });
  test('predict without polymarketConditionIds ⇒ null', () => {
    expect(u1Admit(pm, [pmChild(10, '0xabc')], pred, [child({ market_id: 20, platform: 'predict', pm_condition_ids: null })])).toBeNull();
  });
  test('non predict↔PM pairing (kalshi↔PM) ⇒ null', () => {
    const kal = ev({ id: 3, platform: 'kalshi' });
    expect(u1Admit(kal, [child({ platform: 'kalshi' })], pm, [pmChild(10, '0xabc')])).toBeNull();
  });
});
