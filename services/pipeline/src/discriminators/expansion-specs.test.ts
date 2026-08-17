/**
 * Registry EXPANSION unit tests — the three GUARD-ONLY entries candle_window
 * + org_tour + draw_axis. Invariants:
 *   · all three are GUARD-ONLY → in coherenceSpecs(), NOT in foldKeySpecs() → the
 *     Stage-4 fold-SQL / set keys / certifier are byte-identical.
 *   · the Stage-1 stamp writes them into the discriminators JSONB, dual-writing
 *     NO typed column.
 *   · the Stage-3 leg-coherence belt drops a cross-window / cross-org /
 *     draw↔decisive leg.
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
import { extractCandleWindow } from './specs/candle-window.js';
import { extractOrgTour } from './specs/org-tour.js';
import { extractDrawAxis } from './specs/draw-axis.js';

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
  test('candle_window: guard-only, tolerant, no gatedField, candle_direction only', () => {
    const s = getSpec('candle_window')!;
    expect(s.assertion).toBe('guard-only');
    expect(s.nullPolicy).toBe('tolerant');
    expect(s.gatedField).toBeUndefined();
    expect(s.kinds).toEqual(['candle_direction']);
    expect(s.source).toBe('title-regex');
  });

  test('org_tour: guard-only, block-when-sibling-known, no gatedField, winner kinds', () => {
    const s = getSpec('org_tour')!;
    expect(s.assertion).toBe('guard-only');
    expect(s.nullPolicy).toBe('block-when-sibling-known');
    expect(s.gatedField).toBeUndefined();
    expect(s.kinds).toEqual(['championship_winner', 'match_winner']);
  });

  test('draw_axis: guard-only, block-when-sibling-known, no gatedField, fixture kinds', () => {
    const s = getSpec('draw_axis')!;
    expect(s.assertion).toBe('guard-only');
    expect(s.nullPolicy).toBe('block-when-sibling-known');
    expect(s.gatedField).toBeUndefined();
    expect(s.kinds).toEqual(['match_winner', 'halftime_leader', 'both_teams_score']);
    expect(s.source).toBe('gated-field');
  });
});

describe('guard-only invariant — Stage-4 surfaces byte-identical', () => {
  const NAMES = ['candle_window', 'org_tour', 'draw_axis'];

  test('none join foldKeySpecs(); all join coherenceSpecs()', () => {
    const fold = foldKeySpecs().map((s) => s.name);
    const coh = coherenceSpecs().map((s) => s.name);
    for (const n of NAMES) {
      expect(fold).not.toContain(n);
      expect(coh).toContain(n);
    }
  });

  test('fold-SQL generators + set key ignore the expansion specs', () => {
    for (const frag of [discFoldFragment('a', 'b'), builderDiscFoldFragment('a', 'b'), setDiscKey('x')]) {
      for (const n of NAMES) expect(frag).not.toContain(n);
    }
  });

  test('certifier demote never fires on the expansion (guard-only) discriminators', () => {
    const slot = (disc: Record<string, string | null>) => ({ disc, is_residual: false });
    expect(hasFoldKeyDiscriminatorViolation([
      slot({ candle_window: '5', org_tour: 'ufc', draw_axis: 'draw' }),
      slot({ candle_window: '15', org_tour: 'pga', draw_axis: 'decisive' }),
    ])).toBeNull();
  });
});

describe('extractCandleWindow', () => {
  test.each([
    ['Bitcoin Up or Down - May 14, 10:30AM-10:35AM ET', '5'],
    ['ETH Up or Down - 4:00AM - 4:15AM ET', '15'],
    ['BTC Up or Down - 5 Min', '5'],
    ['XRP Up or Down - 1 hour', '60'],
    ['Solana Up or Down - Daily', '1440'],
    ['BNB Up or Down - Weekly', '10080'],
    ['Ethereum Up or Down on May 10?', '1440'],
  ])('%s → %s', (title, dur) => expect(extractCandleWindow(title)).toBe(dur));

  test('ambiguous single-hour → null (soundness direction)', () => {
    expect(extractCandleWindow('XRP Up or Down - May 14, 5AM ET')).toBeNull();
  });

  test('non-crypto Up or Down → null (asset gate)', () => {
    expect(extractCandleWindow('S&P 500 (SPX) Up or Down - 5 Min')).toBeNull();
    expect(extractCandleWindow('Trump approval Up or Down this week')).toBeNull();
  });

  test('null/empty tolerated', () => {
    expect(extractCandleWindow(null)).toBeNull();
    expect(extractCandleWindow('')).toBeNull();
  });
});

describe('extractOrgTour', () => {
  test.each([
    ['Will Aaron Rai win the PGA Championship?', 'pga'],
    ['Will Adela Cernousek win the LPGA Kroger Queen City?', 'lpga'],
    ['Will Aaron Cockerill win on the DP World Tour event?', 'dp_world'],
    ['Who wins the UFC lightweight title?', 'ufc'],
    ['Will X win the WBC heavyweight belt?', 'wbc'],
  ])('%s → %s', (title, tok) => expect(extractOrgTour(title)).toBe(tok));

  test('lpga does not also fire pga (distinct tokens)', () => {
    expect(extractOrgTour('LPGA Tour Championship winner')).toBe('lpga');
  });

  test('two distinct orgs → null (ambiguous)', () => {
    expect(extractOrgTour('WBC vs WBA unification: who leaves champion?')).toBeNull();
  });

  test('no org token → null', () => {
    expect(extractOrgTour('Will Arsenal beat Chelsea?')).toBeNull();
    expect(extractOrgTour(null)).toBeNull();
  });

  // Kalshi carries the org in the event, not the title. The canonical_event
  // surface stamps the same-org fold so the Stage-3 belt does not false-drop
  // the Kalshi legs against their PM `ufc` sibling.
  test('org token from canonical_event when title lacks it (Kalshi UFC)', () => {
    expect(
      extractOrgTour(
        'Who will be the Welterweight Title Holder on Dec 31, 2026?',
        '2026 ufc welterweight title holder on dec 31, 2026',
      ),
    ).toBe('ufc');
  });

  test('title org still wins when CE agrees (PM UFC sibling)', () => {
    expect(
      extractOrgTour('Will Belal Muhammad be the UFC Welterweight Champion?', '2026 ufc welterweight'),
    ).toBe('ufc');
  });

  test('title × CE cross-org disagreement stays null (both-or-neither)', () => {
    expect(extractOrgTour('Will X win the PGA event?', '2026 liv golf championship')).toBeNull();
  });
});

describe('extractDrawAxis', () => {
  const ctx = (over: Partial<LLMMarketNormalization>) => ({
    title: 't', outcomeLabel: over.outcome_label ?? null, eventKind: 'match_winner',
    matchSource: null, platform: 'polymarket', raw: null,
    gated: baseNorm(over) as unknown as Record<string, unknown>, kb: null,
  });

  test('draw slot via canonical_subject → draw', () => {
    expect(extractDrawAxis(ctx({ canonical_subject: 'Draw' }))).toBe('draw');
    expect(extractDrawAxis(ctx({ canonical_subject: 'tie' }))).toBe('draw');
  });

  test('draw slot via outcome_label → draw', () => {
    expect(extractDrawAxis(ctx({ canonical_subject: 'x', outcome_label: 'draw' }))).toBe('draw');
  });

  test('named side → decisive', () => {
    expect(extractDrawAxis(ctx({ canonical_subject: 'Arsenal FC' }))).toBe('decisive');
  });

  test("'tiebreaker' subject is NOT a draw (exact-token guard)", () => {
    expect(extractDrawAxis(ctx({ canonical_subject: 'Tiebreaker' }))).toBe('decisive');
  });

  test('empty subject + no draw token → null', () => {
    expect(extractDrawAxis(ctx({ canonical_subject: '  ' }))).toBeNull();
  });
});

describe('stamp (consumer 1)', () => {
  test('candle_direction: candle_window into JSONB, no typed column written', () => {
    const norm = baseNorm({ event_kind: 'candle_direction' });
    stampDiscriminators({ title: 'BTC Up or Down - 15 Min', platform: 'limitless' }, norm);
    expect(norm.discriminators?.candle_window).toBe('15');
  });

  test('non-carrying kind: candle_window NOT stamped', () => {
    expect(specsForKind('match_winner').map((s) => s.name)).not.toContain('candle_window');
  });

  test('championship_winner: org_tour into JSONB', () => {
    const norm = baseNorm({ event_kind: 'championship_winner', canonical_subject: 'Aaron Rai' });
    stampDiscriminators({ title: 'Will Aaron Rai win the PGA Championship?', platform: 'kalshi' }, norm);
    expect(norm.discriminators?.org_tour).toBe('pga');
  });

  test('match_winner: draw_axis stamps the role; subject untouched', () => {
    const draw = baseNorm({ event_kind: 'match_winner', canonical_subject: 'Draw', outcome_label: 'draw' });
    stampDiscriminators({ title: 'Getafe vs Oviedo: Draw?', platform: 'polymarket' }, draw);
    expect(draw.discriminators?.draw_axis).toBe('draw');
    expect(draw.canonical_subject).toBe('Draw'); // authoritative, unchanged

    const side = baseNorm({ event_kind: 'match_winner', canonical_subject: 'Getafe CF' });
    stampDiscriminators({ title: 'Getafe vs Oviedo: Getafe win?', platform: 'polymarket' }, side);
    expect(side.discriminators?.draw_axis).toBe('decisive');
  });
});

describe('coherence (consumer 2) — cross-window / cross-org / draw drop', () => {
  const legs = [
    { market_id: 1, outcome_id: 'o' },
    { market_id: 2, outcome_id: 'o' },
    { market_id: 3, outcome_id: 'o' },
  ];
  const only = (name: string, vals: Record<number, string | null>) =>
    (s: DiscriminatorSpec, mid: number) => (s.name === name ? vals[mid] ?? null : null);

  test('candle_window (tolerant): both-known-differ drop; NULL leg kept', () => {
    const r = discriminatorCoherenceDrops(legs, only('candle_window', { 1: '5', 2: '15', 3: null }));
    expect([...r.drop]).toEqual([2]);
    expect(r.perSpec['candle_window']).toBe(1);
  });

  test('org_tour (block-when-sibling-known): differ AND NULL-bridge drop', () => {
    const r = discriminatorCoherenceDrops(legs, only('org_tour', { 1: 'wbc', 2: 'wba', 3: null }));
    expect([...r.drop].sort()).toEqual([2, 3]);
    expect(r.perSpec['org_tour']).toBe(2);
  });

  test('draw_axis (block-when-sibling-known): draw↔decisive collision drops', () => {
    const r = discriminatorCoherenceDrops(legs, only('draw_axis', { 1: 'draw', 2: 'decisive', 3: null }));
    expect([...r.drop].sort()).toEqual([2, 3]);
    expect(r.perSpec['draw_axis']).toBe(2);
  });
});
