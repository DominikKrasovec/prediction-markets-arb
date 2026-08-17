/**
 * resolution_scope backfill — pure-part tests (no DB):
 *   · computeScopeForRow replays sync-time detection per platform,
 *   · idempotency invariant (a stamped row can never be re-selected: every
 *     computed scope is concrete, and the pass only scans IS NULL rows),
 *   · the self-watermarking gate.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeScopeForRow,
  shouldRunScopeBackfill,
  type ScopeBackfillRow,
} from './backfill-resolution-scope.js';

const row = (partial: Partial<ScopeBackfillRow>): ScopeBackfillRow =>
  ({ id: 1, platform: 'kalshi', title: '', raw: null, ...partial } as ScopeBackfillRow);

describe('computeScopeForRow — detector over stored raw, per platform', () => {
  test('kalshi: rules_primary regulation phrasing → regulation', () => {
    expect(
      computeScopeForRow(row({
        platform: 'kalshi',
        title: 'Fluminense vs Sao Paulo Winner?',
        raw: {
          rules_primary:
            'If Tie wins the game after 90 minutes plus stoppage time ' +
            '(does not include extra time or penalties), then the market resolves to Yes.',
        },
      })),
    ).toBe('regulation');
  });

  test('predict: native description → detector input', () => {
    expect(
      computeScopeForRow(row({
        platform: 'predict',
        title: 'Team A vs Team B',
        raw: { description: 'Based on the final score including any overtime periods.' },
      })),
    ).toBe('incl_overtime');
  });

  test('polymarket: description; limitless: rules fallback', () => {
    expect(
      computeScopeForRow(row({ platform: 'polymarket', raw: { description: 'including any overtime periods' } })),
    ).toBe('incl_overtime');
    expect(
      computeScopeForRow(row({ platform: 'limitless', raw: { rules: 'result at the end of regulation' } })),
    ).toBe('regulation');
  });

  test('no raw row (LEFT JOIN miss) → title-only detection, still concrete', () => {
    expect(computeScopeForRow(row({ platform: 'predict', title: 'Will X advance to the final?', raw: null })))
      .toBe('incl_overtime');
    expect(computeScopeForRow(row({ platform: 'kalshi', title: 'Some market', raw: null })))
      .toBe('unspecified');
  });

  test('IDEMPOTENCY INVARIANT: every computed scope is concrete (never null) — a second run selects 0 rows', () => {
    const inputs: ScopeBackfillRow[] = [
      row({ platform: 'kalshi', title: '', raw: {} }),
      row({ platform: 'predict', title: '', raw: null }),
      row({ platform: 'polymarket', title: 'x', raw: { description: '' } }),
      row({ platform: 'limitless', title: 'y', raw: 42 }),
    ];
    for (const r of inputs) {
      const scope = computeScopeForRow(r);
      expect(scope).toBeTruthy();
      expect(['regulation', 'incl_overtime', 'aggregate', 'unspecified']).toContain(scope);
    }
  });
});

describe('shouldRunScopeBackfill — self-watermarking gate (DW-51 idiom)', () => {
  test('NULL rows outstanding → run', () => {
    expect(shouldRunScopeBackfill(1)).toEqual({ run: true, reason: 'null-scope-rows' });
    expect(shouldRunScopeBackfill(65_166)).toEqual({ run: true, reason: 'null-scope-rows' });
  });
  test('converged (0 NULL rows) → skip, no scan this tick', () => {
    expect(shouldRunScopeBackfill(0)).toEqual({ run: false, reason: 'converged' });
  });
});

describe('write-path guards (source contract)', () => {
  const src = readFileSync(join(import.meta.dir, 'backfill-resolution-scope.ts'), 'utf8');
  test('the UPDATE re-guards on IS NULL — never overwrites text/structural stamps', () => {
    expect(src).toMatch(/UPDATE markets m[\s\S]{0,300}AND m\.resolution_scope IS NULL/);
  });
  test('scan is keyset-paginated over IS NULL only', () => {
    expect(src).toContain('WHERE m.resolution_scope IS NULL AND m.id > $1');
  });
});
