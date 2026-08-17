/**
 * Tests for detectResolutionScope's limitless sport-default arm, plus the
 * rollupCount telemetry counter.
 *
 * The sport-default fires ONLY on the terminal SILENT verdict (limitless
 * match_winner/championship_winner: soccer→regulation, basketball→incl_overtime).
 * It never overrides an explicit inclusion / exclusion / mixed text verdict, and
 * is gated off for other platforms, kinds, sports, and when no ctx is supplied
 * (backward-compatible with the sync-time 2-arg call).
 */
import { describe, test, expect } from 'bun:test';
import type { Platform } from '@arb/types';
import { detectResolutionScope, type ScopeDefaultCtx } from './market-normalizer.js';
import { rollupCount, beltCensus, resetBeltCensus } from '../discriminators/telemetry.js';

const ctx = (eventKind: string, sport: string | null, platform: Platform = 'limitless'): ScopeDefaultCtx =>
  ({ platform, eventKind, sport });

describe('detectResolutionScope — limitless sport-default (WP-3.2 §3.8b)', () => {
  test('silent limitless soccer winner → regulation', () => {
    expect(detectResolutionScope('Will Barcelona win?', '', ctx('match_winner', 'soccer'))).toBe('regulation');
    expect(detectResolutionScope('Champions League winner', '', ctx('championship_winner', 'soccer'))).toBe('regulation');
    expect(detectResolutionScope('t', '', ctx('match_winner', 'Soccer'))).toBe('regulation'); // case-insensitive sport
  });

  test('silent limitless basketball winner → incl_overtime', () => {
    expect(detectResolutionScope('Will the Lakers win?', '', ctx('match_winner', 'basketball'))).toBe('incl_overtime');
    expect(detectResolutionScope('NBA champion', '', ctx('championship_winner', 'basketball'))).toBe('incl_overtime');
  });

  test('sport-default NEVER overrides an explicit text verdict', () => {
    // knockout "advance" → incl_overtime, regardless of the soccer regulation default
    expect(detectResolutionScope('Will X advance to the final?', '', ctx('championship_winner', 'soccer'))).toBe('incl_overtime');
    // explicit regulation text on a basketball winner → regulation (text wins over the incl_overtime default)
    expect(detectResolutionScope('t', 'settled at the end of regulation', ctx('match_winner', 'basketball'))).toBe('regulation');
    // explicit incl_overtime on soccer → incl_overtime (text wins over the regulation default)
    expect(detectResolutionScope('t', 'based on the final score including any overtime periods', ctx('match_winner', 'soccer'))).toBe('incl_overtime');
    // Kalshi negated-inclusion soccer text stays regulation even with a soccer ctx (agrees anyway)
    expect(detectResolutionScope('t', 'after 90 minutes plus stoppage time (does not include extra time or penalties)', ctx('match_winner', 'soccer'))).toBe('regulation');
  });

  test('sport-default does NOT override a MIXED (disagreeing) verdict', () => {
    // exclusion + affirmative counts-voice → 'unspecified' (mixed components); the
    // default must not force regulation (only the terminal SILENT arm defaults).
    const mixed = 'extra time counts but penalties are excluded';
    expect(detectResolutionScope('t', mixed)).toBe('unspecified');
    expect(detectResolutionScope('t', mixed, ctx('match_winner', 'soccer'))).toBe('unspecified');
  });

  test('gated OFF: non-limitless / non-winner kind / other sport / null sport / no ctx', () => {
    expect(detectResolutionScope('Will Barcelona win?', '', ctx('match_winner', 'soccer', 'kalshi'))).toBe('unspecified');
    expect(detectResolutionScope('Will Barcelona win?', '', ctx('match_winner', 'soccer', 'polymarket'))).toBe('unspecified');
    expect(detectResolutionScope('Total goals over 2.5?', '', ctx('match_total_metric', 'soccer'))).toBe('unspecified');
    expect(detectResolutionScope('Will X win?', '', ctx('match_winner', 'tennis'))).toBe('unspecified'); // sport not in default set
    expect(detectResolutionScope('Will X win?', '', ctx('match_winner', null))).toBe('unspecified');
    expect(detectResolutionScope('Will Barcelona win?', '')).toBe('unspecified'); // no ctx = backward compatible
  });
});

describe('rollupCount telemetry counter (WP-3.2 §3.8a)', () => {
  test('accumulates under rollup.<name>; no-op on n <= 0', () => {
    resetBeltCensus();
    rollupCount('resolution_scope_conflict', 3);
    rollupCount('resolution_scope_conflict', 2); // accumulates, not overwrites
    rollupCount('resolution_kind_conflict', 0); // no-op
    rollupCount('resolution_kind_conflict', -5); // no-op
    const c = beltCensus();
    expect(c['rollup.resolution_scope_conflict']).toBe(5);
    expect(c['rollup.resolution_kind_conflict']).toBeUndefined();
    resetBeltCensus();
  });
});
