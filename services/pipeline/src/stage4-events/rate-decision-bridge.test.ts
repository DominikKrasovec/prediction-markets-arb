/**
 * rate-decision-bridge planning core (pure, no DB) — the cross-venue meeting
 * bridge over the June/July-2026 Fed rung rosters, plus the spec §3.2 refusal /
 * separation cases (unknown-emitter refuse, different-meeting no-edge,
 * cross-platform gating, non-lattice refuse).
 *
 * Legs carry the UNIFIED-convention gated stamps the emitters produce
 * (kalshi-series.ts fedDecisionStamp + text-deterministic.ts): exact → at/±N,
 * cumulative → above/below/±N; kalshi cumulative is STRICT, the trio NON-STRICT.
 */
import { describe, test, expect } from 'bun:test';
import { planRateDecisionBridge, type RateLegInput, type RateBridgeEdgeRow } from './rate-decision-bridge.js';
import type { BoundStrictness } from '../discriminators/specs/bound-strictness.js';

let nextQid = 1;
/** Strictness is a per-MARKET stamp (`boundStrictness`), not a per-emitter
 *  constant. `at` rungs pass null (a point ignores strictness); cumulative
 *  rungs carry 'strict' ('>N') or 'closed' ('N+'). */
function leg(
  platform: string,
  matchSource: string,
  dir: 'at' | 'above' | 'below',
  bps: number,
  boundStrictness: BoundStrictness | null,
  month = 'june',
  year = 2026,
): RateLegInput {
  return {
    questionId: nextQid++,
    platform,
    matchSource,
    dir,
    signedBps: bps,
    canonicalEvent: `fed decision ${month} ${year}`,
    canonicalSubject: 'Federal Reserve',
    conditionDate: `${year}-01-01`,
    outcomeLabel: `${platform}:${dir}/${bps}`,
    boundStrictness,
  };
}

/** One meeting's 5 rungs for a venue, in the unified convention. `strict` venues
 *  (kalshi) stamp cumulative rungs at ±25 with dir above/below (⇔ ≥50 / ≤−50);
 *  non-strict venues stamp the open rung at ±50. The per-market bound_strictness
 *  is 'strict' for the kalshi cumulative rungs, 'closed' for the trio, null for
 *  every exact `at` rung. */
function venueRoster(platform: string, matchSource: string, strict: boolean, month = 'june', year = 2026): RateLegInput[] {
  const openHi = strict ? 25 : 50; // kalshi '>25' ⇔ trio '50+' → both [50,∞)
  const bs: BoundStrictness = strict ? 'strict' : 'closed';
  return [
    leg(platform, matchSource, 'at', 0, null, month, year), // hold → [0,0]
    leg(platform, matchSource, 'at', 25, null, month, year), // +25 → [25,25]
    leg(platform, matchSource, 'at', -25, null, month, year), // −25 → [−25,−25]
    leg(platform, matchSource, 'above', openHi, bs, month, year), // cumulative hike → [50,∞)
    leg(platform, matchSource, 'below', -openHi, bs, month, year), // cumulative cut → (−∞,−50]
  ];
}

function edgeBetween(rows: RateBridgeEdgeRow[], q1: number, q2: number): RateBridgeEdgeRow | undefined {
  return rows.find((r) => (r.a === q1 && r.c === q2) || (r.a === q2 && r.c === q1));
}

describe('planRateDecisionBridge — June 2026 four-venue roster', () => {
  test('5 disjoint interval classes → 30 equiv + 120 mutex, 0 impl, 0 none, belt 0', () => {
    nextQid = 1;
    const legs = [
      ...venueRoster('kalshi', 'kalshi:central-bank-rate', true),
      ...venueRoster('polymarket', 'pm:rate-decision', false),
      ...venueRoster('predict', 'text-deterministic-AG', false),
      ...venueRoster('limitless', 'limitless:econ-fed', false),
    ];
    const plan = planRateDecisionBridge(legs);
    expect(plan.bridgedMeetings).toBe(1);
    expect(plan.skippedLegs).toBe(0);
    expect(plan.unbridgedPairs).toBe(0);
    expect(plan.invalidLegIds).toEqual([]);
    // 4 venues × 5 classes: within-class equiv = 5·C(4,2)=30; between-class mutex
    // = 10 class-pairs · V(V−1)=12 = 120. No proper subsets in the Fed rung set.
    expect(plan.counts).toEqual({ equivalence: 30, strict_implication: 0, mutual_exclusion: 120, none: 0 });
    expect(plan.rows).toHaveLength(150);
    // every symmetric edge is oriented antecedent < consequent (min→max)
    for (const r of plan.rows) expect(r.a).toBeLessThan(r.c);
  });

  test('kalshi strict ">25 hike" ≡ trio "50+ hike" (both ⇔ Δ≥50) → equivalence, not mutex', () => {
    nextQid = 1;
    const kalshi = venueRoster('kalshi', 'kalshi:central-bank-rate', true);
    const pm = venueRoster('polymarket', 'pm:rate-decision', false);
    const plan = planRateDecisionBridge([...kalshi, ...pm]);
    const kalshiHikeOpen = kalshi[3]!.questionId; // above/25 strict → [50,∞)
    const pmHikeOpen = pm[3]!.questionId; // above/50 → [50,∞)
    const e = edgeBetween(plan.rows, kalshiHikeOpen, pmHikeOpen);
    expect(e?.edge_type).toBe('equivalence');
    // kalshi exact +25 vs pm "50+" → disjoint → mutex
    const kalshiExact25 = kalshi[1]!.questionId;
    expect(edgeBetween(plan.rows, kalshiExact25, pmHikeOpen)?.edge_type).toBe('mutual_exclusion');
  });
});

describe('planRateDecisionBridge — the Δ=N implication (synthetic "25+" trio rung)', () => {
  test('kalshi ">25" [50,∞) ⊂ trio "25+" [25,∞) → strict_implication, kalshi is antecedent', () => {
    nextQid = 1;
    const kGt25 = leg('kalshi', 'kalshi:central-bank-rate', 'above', 25, 'strict'); // '>25' → [50,∞)
    const trio25plus = leg('polymarket', 'pm:rate-decision', 'above', 25, 'closed'); // '25+' → [25,∞)
    const plan = planRateDecisionBridge([kGt25, trio25plus]);
    expect(plan.counts.strict_implication).toBe(1);
    expect(plan.counts.equivalence).toBe(0);
    const row = plan.rows[0]!;
    expect(row.edge_type).toBe('strict_implication');
    expect(row.a).toBe(kGt25.questionId); // subset = stronger claim = antecedent
    expect(row.c).toBe(trio25plus.questionId);
  });
});

describe('planRateDecisionBridge — refusals & separation (spec §3.2)', () => {
  test('same-platform pairs are NOT bridged (outcome_sets own them)', () => {
    nextQid = 1;
    // two PM legs, same platform, different rungs → no edge
    const plan = planRateDecisionBridge([
      leg('polymarket', 'pm:rate-decision', 'at', 25, null),
      leg('polymarket', 'pm:rate-decision', 'at', -25, null),
    ]);
    expect(plan.rows).toHaveLength(0);
    expect(plan.unbridgedPairs).toBe(0);
    expect(plan.bridgedMeetings).toBe(0);
  });

  test('different meetings (June vs July) never pair', () => {
    nextQid = 1;
    const plan = planRateDecisionBridge([
      leg('kalshi', 'kalshi:central-bank-rate', 'at', 25, null, 'june', 2026),
      leg('polymarket', 'pm:rate-decision', 'at', 25, null, 'july', 2026),
    ]);
    expect(plan.rows).toHaveLength(0);
    expect(plan.bridgedMeetings).toBe(0);
  });

  test('same month, different YEAR never pair (June 2026 vs June 2027)', () => {
    nextQid = 1;
    const plan = planRateDecisionBridge([
      leg('kalshi', 'kalshi:central-bank-rate', 'at', 25, null, 'june', 2026),
      leg('polymarket', 'pm:rate-decision', 'at', 25, null, 'june', 2027),
    ]);
    expect(plan.rows).toHaveLength(0);
  });

  test('cumulative rung with UNREADABLE strictness (null stamp) → refused, counted in belt', () => {
    // The "unknown emitter" refusal is a per-MARKET check: an above/below rung
    // whose bound_strictness is null cannot be renormalized to an interval, so
    // it is refused (soundness direction). An `at` rung is exempt (a point
    // ignores strictness) — proven by the `known` leg pairing cleanly.
    nextQid = 1;
    const known = leg('kalshi', 'kalshi:central-bank-rate', 'at', 25, null);
    const unreadable = leg('polymarket', 'pm:rate-decision', 'above', 25, null); // null strictness
    const plan = planRateDecisionBridge([known, unreadable]);
    expect(plan.rows).toHaveLength(0);
    expect(plan.unbridgedPairs).toBe(1);
    expect(plan.invalidLegIds).toEqual([unreadable.questionId]);
  });

  test('non-lattice magnitude → leg refused (belt), lattice sibling unaffected', () => {
    nextQid = 1;
    const bad = leg('polymarket', 'pm:rate-decision', 'at', 30, null); // 30 not a multiple of 25
    const good = leg('kalshi', 'kalshi:central-bank-rate', 'at', 25, null);
    const plan = planRateDecisionBridge([bad, good]);
    expect(plan.unbridgedPairs).toBe(1);
    expect(plan.invalidLegIds).toEqual([bad.questionId]);
    expect(plan.rows).toHaveLength(0);
  });

  test('non-Fed instrument (ECB) is dropped before grouping (no lattice entry)', () => {
    nextQid = 1;
    const plan = planRateDecisionBridge([
      {
        questionId: nextQid++, platform: 'polymarket', matchSource: 'pm:rate-decision',
        dir: 'above', signedBps: 25, canonicalEvent: 'ECB Interest Rates: July 2026',
        canonicalSubject: 'European Central Bank', conditionDate: '2026-07-01', outcomeLabel: null,
        boundStrictness: 'closed',
      },
      {
        questionId: nextQid++, platform: 'limitless', matchSource: 'limitless:econ-fed',
        dir: 'above', signedBps: 25, canonicalEvent: 'ECB decision July 2026',
        canonicalSubject: 'European Central Bank', conditionDate: '2026-07-01', outcomeLabel: null,
        boundStrictness: 'closed',
      },
    ]);
    expect(plan.skippedLegs).toBe(2);
    expect(plan.rows).toHaveLength(0);
    expect(plan.unbridgedPairs).toBe(0);
  });
});
