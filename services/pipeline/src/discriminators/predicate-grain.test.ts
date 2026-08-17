/**
 * predicate_grain unit tests.
 * Invariants (guard-only contract):
 *   · guard-only → in coherenceSpecs(), NOT in foldKeySpecs() → the Stage-4
 *     fold-SQL / set keys / certifier are byte-identical.
 *   · the Stage-1 stamp writes predicate_grain into the discriminators JSONB,
 *     dual-writing NO typed column.
 *   · the generic Stage-3 leg-coherence belt drops a CROSS-GRAIN leg and keeps
 *     SAME-GRAIN + NULL legs (tolerant).
 */
import { describe, test, expect } from 'bun:test';
import type { LLMMarketNormalization } from '@arb/types';
import {
  getSpec,
  foldKeySpecs,
  coherenceSpecs,
  specsForKind,
  type DiscriminatorSpec,
} from './registry.js';
import { stampDiscriminators } from './stamp.js';
import { discFoldFragment, builderDiscFoldFragment, setDiscKey } from './fold-sql.js';
import { hasFoldKeyDiscriminatorViolation } from '../stage4-events/outcome-set-certifier.js';
import { discriminatorCoherenceDrops } from './coherence.js';
import { extractPredicateGrain, extractPredicateGrainFromText } from './specs/predicate-grain.js';

const baseNorm = (over: Partial<LLMMarketNormalization>): LLMMarketNormalization => ({
  market_id: 1,
  canonical_subject: 's',
  condition_value: null,
  condition_date: null,
  canonical_event: 'e',
  outcome_label: null,
  resolved_entities: [],
  resolution_source: null,
  confidence: 1,
  condition_shape: 'binary_event',
  condition_direction: null,
  condition_metric: null,
  metric_scope: null,
  temporal_semantics: null,
  value_primary: null,
  value_secondary: null,
  value_unit: null,
  participants: [],
  category_unified: null,
  ...over,
});

describe('registration', () => {
  test('predicate_grain: guard-only, tolerant, no gatedField, kinds all, title-regex', () => {
    const s = getSpec('predicate_grain')!;
    expect(s).toBeDefined();
    expect(s.assertion).toBe('guard-only');
    expect(s.nullPolicy).toBe('tolerant');
    expect(s.gatedField).toBeUndefined();
    expect(s.kinds).toBe('all');
    expect(s.source).toBe('title-regex');
    expect(s.setSplit).toBeUndefined();
  });
});

describe('guard-only invariant — Stage-4 surfaces byte-identical', () => {
  test('NOT in foldKeySpecs(); IS in coherenceSpecs()', () => {
    expect(foldKeySpecs().map((s) => s.name)).not.toContain('predicate_grain');
    expect(coherenceSpecs().map((s) => s.name)).toContain('predicate_grain');
  });

  test('fold-SQL generators + set key ignore predicate_grain', () => {
    for (const frag of [discFoldFragment('a', 'b'), builderDiscFoldFragment('a', 'b'), setDiscKey('x')]) {
      expect(frag).not.toContain('predicate_grain');
    }
  });

  test('certifier demote never fires on predicate_grain (guard-only)', () => {
    const slot = (disc: Record<string, string | null>) => ({ disc, is_residual: false });
    expect(hasFoldKeyDiscriminatorViolation([
      slot({ predicate_grain: 'legal_action:arrest' }),
      slot({ predicate_grain: 'legal_action:charge' }),
    ])).toBeNull();
  });

  test("kinds 'all' → stamped on every kind incl. NULL (the civic/legal fake surface)", () => {
    for (const k of ['other', 'match_winner', 'election_outcome_winner', null]) {
      expect(specsForKind(k).map((s) => s.name)).toContain('predicate_grain');
    }
  });
});

describe('extractPredicateGrainFromText — the verb-class vocabulary', () => {
  test.each([
    // legal_action — the clean-fake family (arrest≠charge)
    ['Will Letitia James be arrested before Jan 2027?', 'legal_action:arrest'],
    ['Will Letitia James be charged with a any crime before Jan 1, 2027?', 'legal_action:charge'],
    ['Will X face federal charges in 2026?', 'legal_action:charge'],
    ['Will X be indicted before 2027?', 'legal_action:indict'],
    ['Will X be convicted in 2026?', 'legal_action:convict'],
    ['Will X be sentenced to prison?', 'legal_action:sentence'],
    // publication — announce≠release
    ['Will Apple announce a foldable iPhone in 2026?', 'publication:announce'],
    ['Will Drake officially release Iceman by June 30, 2026?', 'publication:release'],
    ['Will Project X launch a token by 2027?', 'publication:launch'],
    // enactment — adopt≠use (map-anchored)
    ['Will Utah adopt a new congressional map before 2027?', 'enactment:adopt'],
    ['Will a new map be used in the 2026 Utah election?', 'enactment:use'],
    // involvement — testify≠named
    ['Will Elon Musk testify to Congress about Epstein?', 'involvement:testify'],
    ['Will X be named in the Epstein documents?', 'involvement:named'],
    // departure — resign≠out
    ['Will the CEO resign before 2027?', 'departure:resign'],
    ['Will X be out as the head coach?', 'departure:out'],
    // election_stage — primary≠general
    ['Will X win the Republican primary for Senate?', 'election_stage:primary'],
    ['Will X win the general election?', 'election_stage:general'],
  ])('%s → %s', (title, grain) => expect(extractPredicateGrainFromText(title)).toBe(grain));

  test('cross-grain / ambiguous title → null (soundness direction)', () => {
    // Two distinct grains present ⇒ ambiguous ⇒ no stamp.
    expect(extractPredicateGrainFromText('Will X be arrested and charged with a crime before 2027?')).toBeNull();
    expect(extractPredicateGrainFromText('Will X win the primary and the general election?')).toBeNull();
  });

  test('no predicate verb → null (the vast non-civic surface)', () => {
    expect(extractPredicateGrainFromText('Will Arsenal beat Chelsea?')).toBeNull();
    expect(extractPredicateGrainFromText('Will BTC be above $100k by 2027?')).toBeNull();
    expect(extractPredicateGrainFromText('Will the Yankees score over 4.5 runs?')).toBeNull();
    expect(extractPredicateGrainFromText(null)).toBeNull();
    expect(extractPredicateGrainFromText('')).toBeNull();
  });

  test('anchored — bare stems in non-predicate context do NOT fire', () => {
    // "in charge of" is not a legal charge; "primary care" is not an election
    // primary; "use" without a map is not enactment:use. (Custody-release —
    // "released from prison" — is handled by its own legal_action grain, see the
    // caveat-C3 block below, NOT publication:release.)
    expect(extractPredicateGrainFromText('Who will be in charge of the committee?')).toBeNull();
    expect(extractPredicateGrainFromText('Will primary care costs rise in 2026?')).toBeNull();
    expect(extractPredicateGrainFromText('Will the app be used by 1M people?')).toBeNull();
  });

  // Validation caveats
  describe('C3 — custody-release does NOT stamp publication:release', () => {
    test('"released from prison/jail/custody" → legal_action:release-from-custody, NOT publication:release', () => {
      for (const t of [
        'Will Snowden be released from prison before 2027?',
        'Will X be released from jail in 2026?',
        'Will Assange be released from custody by 2027?',
        'Will the hostages be released from detention?',
      ]) {
        expect(extractPredicateGrainFromText(t)).toBe('legal_action:release-from-custody');
      }
    });

    test('transitive "pardon and release X from prison" → release-from-custody (bounded gap)', () => {
      expect(extractPredicateGrainFromText('Will Trump pardon and release Snowden from prison in 2026?'))
        .toBe('legal_action:release-from-custody');
    });

    test('product release still stamps publication:release (no regression)', () => {
      expect(extractPredicateGrainFromText('Will Drake release Iceman by June 2026?')).toBe('publication:release');
      expect(extractPredicateGrainFromText('Will Apple release a foldable iPhone in 2026?')).toBe('publication:release');
    });

    test('"DOJ releases the Epstein files" keeps its two-grain-ambiguity null (release + named)', () => {
      // "releases" → publication:release (not custody: no "from prison"); "epstein
      // files" → involvement:named. Two grains ⇒ ambiguity gate ⇒ null — unchanged.
      expect(extractPredicateGrainFromText('Will the DOJ release the Epstein files?')).toBeNull();
      expect(extractPredicateGrainFromText('Will the DOJ releases the Epstein files in 2026?')).toBeNull();
    });

    test('custody-release fused with an arrest sibling is a cross-grain drop (freed ⊄ arrested)', () => {
      // Same legal_action FAMILY, different grain ⇒ the belt drops the cross-grain leg.
      expect(extractPredicateGrainFromText('Will X be arrested in 2026?')).toBe('legal_action:arrest');
      expect(extractPredicateGrainFromText('Will X be released from prison in 2026?'))
        .toBe('legal_action:release-from-custody');
    });
  });

  describe('C4 — gerund/participle charge forms (protection-recall)', () => {
    test.each([
      ['Will X be facing charges by 2027?', 'legal_action:charge'],
      ['Will X be facing federal charges in 2026?', 'legal_action:charge'],
      ['Will X be facing criminal charges?', 'legal_action:charge'],
      ['Will X face charges before 2027?', 'legal_action:charge'],
      ['Will X be charged with fraud?', 'legal_action:charge'],
    ])('%s → %s', (t, g) => expect(extractPredicateGrainFromText(t)).toBe(g));
  });

  describe('C5 — any-mechanism "resign or be removed" ⇒ null (multi-grain disjunction)', () => {
    test('disjunctive departure title stamps NOTHING (resign + out ⇒ ambiguity gate)', () => {
      for (const t of [
        'Will the CEO resign or be removed before 2027?',
        'Will X resign or be fired in 2026?',
        'Will the manager resign or be removed from office?',
      ]) {
        expect(extractPredicateGrainFromText(t)).toBeNull();
      }
    });

    test('non-departure "removed from the S&P 500" (index reconstitution) does NOT stamp out', () => {
      // The disjunction-tail arm is anchored to "or (be) removed"; a bare
      // "be removed from the S&P 500" must stay unstamped (KXSP500REMOVEQ).
      expect(extractPredicateGrainFromText('Will Intel be removed from the S&P 500 in Q2 2026?')).toBeNull();
      expect(extractPredicateGrainFromText('Will Trump be impeached and removed from office?')).toBeNull();
    });

    test('single involuntary mechanism still stamps departure:out (forced out / ousted)', () => {
      expect(extractPredicateGrainFromText('Will X be forced out as CEO?')).toBe('departure:out');
      expect(extractPredicateGrainFromText('Will the manager be ousted in 2026?')).toBe('departure:out');
    });

    test('a plain voluntary resign (no removal mechanism) still stamps departure:resign', () => {
      expect(extractPredicateGrainFromText('Will the CEO resign before 2027?')).toBe('departure:resign');
    });
  });
});

// Settlement-non-identical verb/scope pairs: each pair below must resolve to
// distinct grains so cross_question_equiv (and the member-cohesion / Stage-3
// leg-coherence belts) stop equating them. Deny-only: worst case is a
// recall-neutral null; never a false refusal.
describe('F13 — near-synonym equiv pairs resolve to distinct grains', () => {
  test('redistrict ≠ adopt-new-map (Utah c5048/c16676): distinct enactment grains', () => {
    expect(extractPredicateGrainFromText('Will Utah redistrict before the 2026 election?'))
      .toBe('enactment:redistrict');
    expect(extractPredicateGrainFromText('Will Utah adopt a new congressional map before 2027?'))
      .toBe('enactment:adopt');
    // regression: "uses new map" stays enactment:use, distinct from both.
    expect(extractPredicateGrainFromText('Will a new map be used in the 2026 Utah election?'))
      .toBe('enactment:use');
    // a title carrying BOTH verbs (adopt + redistrict) → single-grain gate returns null
    // (net-unchanged vs the old single-adopt stamp; safe — a NULL leg never refuses).
    expect(extractPredicateGrainFromText('Will Utah adopt a new redistricting map in 2026?')).toBeNull();
  });

  test('deal ≠ weapon (Iran nuclear): agreement vs capability are independent settlements', () => {
    expect(extractPredicateGrainFromText('Will the US reach a nuclear deal with Iran in 2026?'))
      .toBe('diplomacy:deal');
    expect(extractPredicateGrainFromText('Will Iran acquire a nuclear weapon by 2027?'))
      .toBe('diplomacy:weapon');
    expect(extractPredicateGrainFromText('Will Iran build a nuclear bomb in 2026?'))
      .toBe('diplomacy:weapon');
    // bare "deal"/"weapon" without the anchored phrase never fire.
    expect(extractPredicateGrainFromText('Will the Yankees weapon of choice change?')).toBeNull();
  });

  test('any-cut ≠ emergency-cut (Fed): scheduled cut vs unscheduled/intermeeting cut', () => {
    expect(extractPredicateGrainFromText('Will the Fed cut rates in March 2026?'))
      .toBe('rate_action:cut');
    expect(extractPredicateGrainFromText('Will there be an emergency rate cut in 2026?'))
      .toBe('rate_action:emergency-cut');
    expect(extractPredicateGrainFromText('Will the Fed make an intermeeting rate cut?'))
      .toBe('rate_action:emergency-cut');
    // an "emergency rate cut" title stamps ONLY emergency-cut (mutually exclusive with
    // `cut` via the `^`-anchored negative lookahead — never a two-grain null).
    // a non-rate "budget cut" never fires.
    expect(extractPredicateGrainFromText('Will Congress pass a budget cut in 2026?')).toBeNull();
  });

  test('US-scope ≠ global (recession / box office): different geography settlements', () => {
    expect(extractPredicateGrainFromText('Will there be a US recession in 2026?'))
      .toBe('geo_scope:us');
    expect(extractPredicateGrainFromText('Will there be a global recession in 2026?'))
      .toBe('geo_scope:global');
    expect(extractPredicateGrainFromText('Will the film cross $500M worldwide box office?'))
      .toBe('geo_scope:global');
    // incidental "American"/"US" with no scope-of-record noun does NOT fire.
    expect(extractPredicateGrainFromText('Will an American win the tournament?')).toBeNull();
  });

  test('charged ≠ arrested (already covered — regression guard the pair stays distinct)', () => {
    expect(extractPredicateGrainFromText('Will X be arrested before 2027?')).toBe('legal_action:arrest');
    expect(extractPredicateGrainFromText('Will X be charged with a federal crime before 2027?'))
      .toBe('legal_action:charge');
  });

  test('the new families never fire on the existing civic/legal test surface (no collision)', () => {
    // spot-check the previously-passing titles keep their grain (a new family must not
    // co-match and null them out).
    expect(extractPredicateGrainFromText('Will Letitia James be arrested before Jan 2027?'))
      .toBe('legal_action:arrest');
    expect(extractPredicateGrainFromText('Will X win the general election?')).toBe('election_stage:general');
    expect(extractPredicateGrainFromText('Will the CEO resign before 2027?')).toBe('departure:resign');
  });
});

describe('extractPredicateGrain (row ctx) — scans title + subject + label', () => {
  const ctx = (over: Partial<LLMMarketNormalization>, title: string) => ({
    title, outcomeLabel: over.outcome_label ?? null, eventKind: over.event_kind ?? null,
    matchSource: null, platform: 'kalshi', raw: null,
    gated: baseNorm(over) as unknown as Record<string, unknown>, kb: null,
  });

  test('verb in title', () => {
    expect(extractPredicateGrain(ctx({}, 'Will John Brennan be arrested before Jan 2027?')))
      .toBe('legal_action:arrest');
  });

  test('verb in outcome_label (PM group-item binary)', () => {
    expect(extractPredicateGrain(ctx({ outcome_label: 'testify to Congress' }, 'Elon Musk')))
      .toBe('involvement:testify');
  });
});

describe('stamp (consumer 1)', () => {
  test('civic/legal binary: predicate_grain into JSONB, no typed column written', () => {
    const norm = baseNorm({ event_kind: 'other', canonical_subject: 'Letitia James' });
    stampDiscriminators({ title: 'Will Letitia James be arrested before Jan 2027?', platform: 'kalshi' }, norm);
    expect(norm.discriminators?.predicate_grain).toBe('legal_action:arrest');
    expect(norm.condition_metric).toBeNull(); // authoritative typed column untouched
  });

  test('the sibling charge market stamps a DIFFERENT grain (same subject)', () => {
    const norm = baseNorm({ event_kind: 'other', canonical_subject: 'Letitia James' });
    stampDiscriminators({ title: 'Will Letitia James be charged with a any crime before Jan 1, 2027?', platform: 'kalshi' }, norm);
    expect(norm.discriminators?.predicate_grain).toBe('legal_action:charge');
  });

  test('non-predicate market: predicate_grain NOT stamped', () => {
    const norm = baseNorm({ event_kind: 'match_winner', canonical_subject: 'Arsenal FC' });
    stampDiscriminators({ title: 'Arsenal vs Chelsea: winner', platform: 'polymarket' }, norm);
    expect(norm.discriminators?.predicate_grain).toBeUndefined();
  });
});

describe('coherence (consumer 2) — cross-grain drop, same-grain zero-flip', () => {
  const legs = [
    { market_id: 1, outcome_id: 'o' },
    { market_id: 2, outcome_id: 'o' },
    { market_id: 3, outcome_id: 'o' },
  ];
  const only = (name: string, vals: Record<number, string | null>) =>
    (s: DiscriminatorSpec, mid: number) => (s.name === name ? vals[mid] ?? null : null);

  test('THE CLEAN FAKE: arrest vs charge leg → the charge leg drops (tolerant both-known-differ)', () => {
    const r = discriminatorCoherenceDrops(legs, only('predicate_grain', {
      1: 'legal_action:arrest', 2: 'legal_action:charge', 3: null,
    }));
    expect([...r.drop]).toEqual([2]);       // cross-grain leg dropped
    expect(r.perSpec['predicate_grain']).toBe(1);
  });

  test('same-grain pair → ZERO drops (arrest Kalshi + arrest PM is a real mirror)', () => {
    const r = discriminatorCoherenceDrops(legs, only('predicate_grain', {
      1: 'legal_action:arrest', 2: 'legal_action:arrest', 3: null,
    }));
    expect(r.drop.size).toBe(0);
  });

  test('NULL/unstamped leg is KEPT (tolerant never blocks an unstamped sibling)', () => {
    const r = discriminatorCoherenceDrops(legs, only('predicate_grain', {
      1: 'legal_action:arrest', 2: null, 3: null,
    }));
    expect(r.drop.size).toBe(0);
  });

  test('announce vs release (publication) also drops — the caution-tier class', () => {
    const r = discriminatorCoherenceDrops(legs, only('predicate_grain', {
      1: 'publication:announce', 2: 'publication:release', 3: null,
    }));
    expect([...r.drop]).toEqual([2]);
  });
});
