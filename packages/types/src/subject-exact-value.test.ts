/** Exact-subject value-undiscriminated duplicate predicate. Pure: exact-equal
 *  folded subject (>=5 chars) + non-discriminating value tuple + exact-equal
 *  outcome slug. The distinct-KB-entity veto is applied by each classifyPair,
 *  not here. */
import { describe, it, expect } from 'bun:test';
import { subjectExactValueUndiscriminatedDuplicateHit as hit } from './cell-key.js';

// (subjectA, subjectB, ckeyA, ckeyB, vpA, vpB, vsA, vsB, cdA, cdB)
describe('subjectExactValueUndiscriminatedDuplicateHit (F10)', () => {
  it('HITs when subject exact-equal, value tuple both-NULL, slug exact-equal', () => {
    expect(hit('Donald Trump', 'Donald Trump', 'sem:1:donald_trump', 'sem:2:donald_trump',
      null, null, null, null, null, null)).toBe(true);
  });

  it('HITs when both slugs empty (unshaped) + both-NULL value + equal subject', () => {
    expect(hit('Some Award Winner', 'Some Award Winner', null, null,
      null, null, null, null, null, null)).toBe(true);
  });

  it('HITs when value tuple present but EQUAL on both sides (non-discriminating)', () => {
    expect(hit('RCD Mallorca', 'RCD Mallorca', 'sem:1:m_2_1', 'sem:2:m_2_1',
      '2', '2', '1', '1', 'above', 'above')).toBe(true);
    // numeric equivalence: '2' ≡ '2.0'
    expect(hit('RCD Mallorca', 'RCD Mallorca', 'sem:1:x', 'sem:2:x',
      '2', '2.0', null, null, null, null)).toBe(true);
  });

  // ── LOAD-BEARING value gate: a differing value ⟹ NO hit (score grid released) ──
  it('no-HIT when value_primary differs (set 857 Mallorca score grid)', () => {
    expect(hit('RCD Mallorca', 'RCD Mallorca', 'sem:1:m_0_0', 'sem:2:m_1_1',
      '0', '1', '0', '1', null, null)).toBe(false);
  });
  it('no-HIT when value_secondary differs (same value_primary rung)', () => {
    expect(hit('RCD Mallorca', 'RCD Mallorca', 'sem:1:m_2_1', 'sem:2:m_2_0',
      '2', '2', '1', '0', null, null)).toBe(false);
  });
  it('no-HIT when one value is NULL and the other is not (grid residual vs scoreline)', () => {
    expect(hit('RCD Mallorca', 'RCD Mallorca', 'sem:1:m_other', 'sem:2:m_0_0',
      null, '0', null, '0', null, null)).toBe(false);
  });
  it('no-HIT when condition_direction differs', () => {
    expect(hit('Team Total', 'Team Total', 'sem:1:x', 'sem:2:x',
      null, null, null, null, 'above', 'below')).toBe(false);
  });

  // ── outcome-slug guard: a DIFFERING slug is a real discriminator ──
  it('no-HIT when slugs differ (donald_trump vs donald_trump_jr — distinct people)', () => {
    // participants may be KB-mislabeled both "Donald Trump" (veto defeated), so the
    // slug guard is what keeps Trump ≠ Trump Jr from false-merging.
    expect(hit('2028 Republican VP nominee', '2028 Republican VP nominee',
      'sem:1:donald_trump', 'sem:2:donald_trump_jr', null, null, null, null, null, null)).toBe(false);
  });
  it('no-HIT when slugs differ (artist_1 vs artist_10; other vs other_region)', () => {
    expect(hit('Top Artist on Spotify', 'Top Artist on Spotify',
      'sem:1:artist_1', 'sem:2:artist_10', null, null, null, null, null, null)).toBe(false);
    expect(hit('MSI 2026 Champion', 'MSI 2026 Champion',
      'sem:1:other', 'sem:2:other_region', null, null, null, null, null, null)).toBe(false);
  });

  // ── subject gate ──
  it('no-HIT when subjects differ (not the exact-equal case)', () => {
    expect(hit('Anthropic', 'Anthropic acquired before 2027', 'sem:1:x', 'sem:2:x',
      null, null, null, null, null, null)).toBe(false);
  });
  it('no-HIT when folded subject < 5 chars', () => {
    expect(hit('BP', 'BP', 'sem:1:x', 'sem:2:x', null, null, null, null, null, null)).toBe(false);
  });
  it('no-HIT on null/empty subjects', () => {
    expect(hit(null, null, 'sem:1:x', 'sem:2:x', null, null, null, null, null, null)).toBe(false);
    expect(hit('', '', null, null, null, null, null, null, null, null)).toBe(false);
  });
  it('subject fold is space/case-invariant (equal after fold ⟹ still HIT)', () => {
    expect(hit('Donald  Trump', 'donald trump', 'sem:1:x', 'sem:2:x',
      null, null, null, null, null, null)).toBe(true);
  });
});
